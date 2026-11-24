import {
  getGenerativeModel,
  InferenceMode,
  InferenceSource,
  Schema,
} from "firebase/ai";
import { getFirebaseAI } from "./firebase";
import type {
  DeviceAvailability,
  InferencePath,
  RunMeta,
  TriageMode,
  TriageResult,
} from "./types";

// Cloud model for both the hybrid fallback and the deep diagnosis step.
// This is the Firebase AI Logic SDK's default hybrid cloud model
// (DEFAULT_HYBRID_IN_CLOUD_MODEL in @firebase/ai), so it is pinned here
// explicitly instead of relying on the default.
export const CLOUD_MODEL = "gemini-3.5-flash-lite";

// On-device Gemini Nano has a small context window, so triage input is capped.
// Cloud diagnosis can take more.
export const TRIAGE_MAX_CHARS = 6000;
export const DIAGNOSIS_MAX_CHARS = 12000;

const triageSchema = Schema.object({
  properties: {
    severity: Schema.enumString({ enum: ["P1", "P2", "P3", "P4"] }),
    category: Schema.enumString({
      enum: [
        "deploy",
        "infrastructure",
        "database",
        "network",
        "application",
        "security",
        "unknown",
      ],
    }),
    component: Schema.string(),
    summary: Schema.string(),
    confidence: Schema.number(),
    signals: Schema.array({ items: Schema.string() }),
  },
  optionalProperties: ["signals"],
});

const TRIAGE_SYSTEM_PROMPT = `You are an on-call incident triage assistant for a DevOps team.
Read the incident report or logs and classify it. Be terse and factual.
- severity: P1 = service down or data loss, P2 = major feature broken for many users,
  P3 = degraded or limited impact, P4 = minor or cosmetic.
- category: pick the single best fit.
- component: the service, job, or system most likely involved (short name, e.g. "payments-api").
- summary: one plain sentence stating what is wrong.
- confidence: 0 to 1, how sure you are about the classification.
- signals: up to 5 short quotes or facts from the input that support the classification.`;

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

function mapSource(source: string | undefined): InferencePath {
  if (source === InferenceSource.ON_DEVICE) return "on_device";
  if (source === InferenceSource.IN_CLOUD) return "in_cloud";
  return "unknown";
}

/**
 * Retry a cloud call up to 3 attempts with backoff. The Gemini Developer API
 * free tier returns transient 500s under load ("model is currently
 * experiencing high demand"); for streams the SDK surfaces those as
 * "Failed to parse stream" because the error arrives as plain JSON after
 * the SSE events. A retry a few seconds later usually succeeds.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        // 5s then 15s: the free tier's load spikes clear in seconds, and a
        // slow-but-healthy stream succeeds on the first attempt anyway.
        await new Promise((resolve) =>
          setTimeout(resolve, attempt === 0 ? 5000 : 15000),
        );
      }
    }
  }
  throw lastErr;
}

/** Turn SDK stream errors into something a human can act on. */
function friendlyError(err: unknown, fallback: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/parse stream|parse-failed/i.test(message)) {
    return new Error(
      "The cloud model was busy and cut the answer short. Please try again.",
    );
  }
  return err instanceof Error ? err : new Error(fallback);
}

function parseTriageJson(raw: string): TriageResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("The model did not return valid triage JSON.");
    parsed = JSON.parse(match[0]);
  }
  const obj = parsed as Record<string, unknown>;
  const severity = String(obj.severity ?? "P3").toUpperCase();
  return {
    severity: (["P1", "P2", "P3", "P4"].includes(severity) ? severity : "P3") as TriageResult["severity"],
    category: (String(obj.category ?? "unknown") as TriageResult["category"]) || "unknown",
    component: String(obj.component ?? "unknown"),
    summary: String(obj.summary ?? "No summary returned."),
    confidence: Math.min(1, Math.max(0, Number(obj.confidence ?? 0))),
    signals: Array.isArray(obj.signals)
      ? (obj.signals as unknown[]).map(String).slice(0, 5)
      : [],
  };
}

export async function checkDeviceAvailability(): Promise<DeviceAvailability> {
  try {
    if (typeof LanguageModel === "undefined" || !LanguageModel.availability) {
      return "unsupported";
    }
    const status = await LanguageModel.availability();
    if (status === "available") return "available";
    if (status === "downloading") return "downloading";
    if (status === "downloadable") return "downloadable";
    return "unavailable";
  } catch {
    return "unsupported";
  }
}

export interface TriageOutcome {
  triage: TriageResult;
  meta: RunMeta;
  inputTruncated: boolean;
}

/**
 * Stage 1: fast structured triage. Hybrid inference: the on-device model
 * (Gemini Nano) runs when available, with cloud fallback, depending on mode.
 * Must be called from a user gesture so the on-device model can initialize.
 */
export async function runTriage(
  input: string,
  mode: TriageMode,
  onDownloadProgress?: (fraction: number) => void,
): Promise<TriageOutcome> {
  const ai = getFirebaseAI();
  if (!ai) throw new Error("Firebase is not configured. See the setup notes below.");

  const { text, truncated } = truncate(input, TRIAGE_MAX_CHARS);

  const inferenceMode =
    mode === "only_on_device"
      ? InferenceMode.ONLY_ON_DEVICE
      : mode === "only_in_cloud"
        ? InferenceMode.ONLY_IN_CLOUD
        : InferenceMode.PREFER_ON_DEVICE;

  const model = getGenerativeModel(ai, {
    mode: inferenceMode,
    inCloudParams: {
      model: CLOUD_MODEL,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: triageSchema,
      },
    },
    onDeviceParams: {
      promptOptions: {
        responseConstraint: triageSchema,
      },
    },
  });

  const started = performance.now();

  // Required after a user interaction and before the first prompt.
  // Skipped in cloud-only mode so no model download is triggered.
  if (mode !== "only_in_cloud") {
    await model.initializeDeviceModel(onDownloadProgress);
  }

  let result;
  try {
    result = await withRetry(() =>
      model.generateContent(`${TRIAGE_SYSTEM_PROMPT}\n\n--- Incident ---\n${text}`),
    );
  } catch (err) {
    if (mode === "only_on_device") {
      throw new Error(
        "On-device inference is not available in this browser (Chrome on desktop, version 139 or higher, with the Prompt API flag enabled and the Gemini Nano model downloaded). Switch the mode to prefer on-device or cloud only.",
      );
    }
    throw friendlyError(err, "Triage failed. Try again.");
  }

  const latencyMs = Math.round(performance.now() - started);
  const path = mapSource(result.response.inferenceSource);
  const triage = parseTriageJson(result.response.text());

  return {
    triage,
    inputTruncated: truncated,
    meta: {
      path,
      modelLabel:
        path === "on_device"
          ? "Gemini Nano (on-device)"
          : path === "in_cloud"
            ? "Gemini 3.5 Flash-Lite (cloud)"
            : "Unknown path",
      latencyMs,
    },
  };
}

export interface DiagnosisOutcome {
  text: string;
  meta: RunMeta;
  inputTruncated: boolean;
}

const DIAGNOSIS_SYSTEM_PROMPT = `You are a senior DevOps incident responder. Given a triage
classification and the raw incident report or logs, write a diagnosis for the
engineer on call. Use plain words, no jargon without explanation. Structure
your answer with exactly these headings, in this order:

## What happened
## Likely root cause
## Evidence
## Fix now
## Verify the fix
## Prevent next time

Rules:
- Under "Fix now", give numbered steps in the order to run them. Include the
  exact commands where a command is the right action, in code blocks.
- Only state facts supported by the input or the triage. Mark guesses as guesses.
- If the input is too thin to diagnose, say so and list what to check first.
- Keep the whole answer focused; no filler, no marketing language.`;

/**
 * Stage 2: full diagnosis. Cloud-only by design: the long-form analysis runs
 * on the cloud model while the quick triage above stays on-device when possible.
 * Streams text so the UI updates as the answer arrives.
 */
export async function runDiagnosis(
  input: string,
  triage: TriageResult,
  onChunk: (partialText: string) => void,
): Promise<DiagnosisOutcome> {
  const ai = getFirebaseAI();
  if (!ai) throw new Error("Firebase is not configured. See the setup notes below.");

  const { text, truncated } = truncate(input, DIAGNOSIS_MAX_CHARS);

  const model = getGenerativeModel(ai, { model: CLOUD_MODEL });
  const started = performance.now();

  const prompt =
    `${DIAGNOSIS_SYSTEM_PROMPT}\n\n--- Triage ---\n` +
    `Severity: ${triage.severity}\nCategory: ${triage.category}\n` +
    `Component: ${triage.component}\nSummary: ${triage.summary}\n` +
    `Confidence: ${triage.confidence}\n\n--- Incident ---\n${text}`;

  let fullText = "";
  try {
    await withRetry(async () => {
      fullText = "";
      onChunk("");
      const streamResult = await model.generateContentStream(prompt);
      for await (const chunk of streamResult.stream) {
        fullText += chunk.text();
        onChunk(fullText);
      }
    });
  } catch (err) {
    throw friendlyError(err, "Diagnosis failed. Try again.");
  }

  return {
    text: fullText,
    inputTruncated: truncated,
    meta: {
      path: "in_cloud",
      modelLabel: "Gemini 3.5 Flash-Lite (cloud)",
      latencyMs: Math.round(performance.now() - started),
    },
  };
}
