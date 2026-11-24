import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkDeviceAvailability,
  runDiagnosis,
  runTriage,
  TRIAGE_MAX_CHARS,
} from "./lib/triage";
import { appCheckMode, firebaseConfigured } from "./lib/firebase";
import { SAMPLE_INCIDENTS } from "./lib/samples";
import type {
  DeviceAvailability,
  HistoryEntry,
  RunMeta,
  TriageMode,
  TriageResult,
} from "./lib/types";
import "./App.css";

const HISTORY_KEY = "triage-copilot-history";
const HISTORY_LIMIT = 10;

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
  } catch {
    // Storage full or unavailable; history is a convenience, not critical.
  }
}

const MODE_LABELS: Record<TriageMode, string> = {
  prefer_on_device: "Prefer on-device",
  only_on_device: "On-device only",
  only_in_cloud: "Cloud only",
};

const DEVICE_LABELS: Record<DeviceAvailability, string> = {
  checking: "Checking on-device model…",
  available: "On-device model ready (Gemini Nano)",
  downloading: "On-device model downloading…",
  downloadable: "On-device model not downloaded yet",
  unavailable: "On-device model unavailable here",
  unsupported: "On-device AI not supported in this browser",
};

function severityClass(severity: string): string {
  return `severity severity-${severity.toLowerCase()}`;
}

/** Minimal markdown rendering: headings, bold, code, code blocks, lists. */
function renderMarkdown(text: string) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let listItems: string[] | null = null;
  let ordered = false;

  const flushList = () => {
    if (!listItems) return;
    const items = listItems;
    if (ordered) {
      blocks.push(
        <ol key={`ol-${blocks.length}`}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ol>,
      );
    } else {
      blocks.push(
        <ul key={`ul-${blocks.length}`}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
    }
    listItems = null;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flushList();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      blocks.push(
        <pre key={`pre-${blocks.length}`}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    if (line.startsWith("## ")) {
      flushList();
      blocks.push(<h3 key={`h-${blocks.length}`}>{renderInline(line.slice(3))}</h3>);
      i += 1;
      continue;
    }
    const orderedMatch = line.match(/^\d+\.\s+(.*)/);
    const bulletMatch = line.match(/^[-*]\s+(.*)/);
    if (orderedMatch || bulletMatch) {
      const isOrdered = Boolean(orderedMatch);
      if (listItems === null || ordered !== isOrdered) {
        flushList();
        listItems = [];
        ordered = isOrdered;
      }
      listItems.push((orderedMatch ?? bulletMatch)![1]);
      i += 1;
      continue;
    }
    if (line.trim() === "") {
      flushList();
      i += 1;
      continue;
    }
    flushList();
    blocks.push(<p key={`p-${blocks.length}`}>{renderInline(line)}</p>);
    i += 1;
  }
  flushList();
  return blocks;
}

function renderInline(text: string): React.ReactNode {
  // Bold and inline code only; keeps the renderer small and predictable.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={idx}>{part.slice(1, -1)}</code>;
    }
    return <span key={idx}>{part}</span>;
  });
}

function PathBadge({ meta }: { meta: RunMeta }) {
  const label =
    meta.path === "on_device"
      ? "Ran on-device"
      : meta.path === "in_cloud"
        ? "Ran in cloud"
        : "Path unknown";
  const cls =
    meta.path === "on_device"
      ? "badge badge-device"
      : meta.path === "in_cloud"
        ? "badge badge-cloud"
        : "badge";
  return (
    <span className="meta-line">
      <span className={cls}>{label}</span>
      <span className="meta-text">{meta.modelLabel}</span>
      <span className="meta-text">{(meta.latencyMs / 1000).toFixed(1)}s</span>
    </span>
  );
}

export default function App() {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<TriageMode>("prefer_on_device");
  const [device, setDevice] = useState<DeviceAvailability>("checking");

  const [triageBusy, setTriageBusy] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [triage, setTriage] = useState<TriageResult | null>(null);
  const [triageMeta, setTriageMeta] = useState<RunMeta | null>(null);
  const [triageError, setTriageError] = useState<string | null>(null);
  const [triageTruncated, setTriageTruncated] = useState(false);

  const [diagnosisBusy, setDiagnosisBusy] = useState(false);
  const [diagnosis, setDiagnosis] = useState<string | null>(null);
  const [diagnosisMeta, setDiagnosisMeta] = useState<RunMeta | null>(null);
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null);

  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [copied, setCopied] = useState<string | null>(null);
  const currentEntryId = useRef<string | null>(null);

  useEffect(() => {
    checkDeviceAvailability().then(setDevice);
  }, []);

  const persistHistory = useCallback((entries: HistoryEntry[]) => {
    setHistory(entries);
    saveHistory(entries);
  }, []);

  const handleTriage = useCallback(async () => {
    if (!input.trim() || triageBusy) return;
    setTriageBusy(true);
    setTriageError(null);
    setTriage(null);
    setTriageMeta(null);
    setDiagnosis(null);
    setDiagnosisMeta(null);
    setDiagnosisError(null);
    setDownloadProgress(null);
    try {
      const outcome = await runTriage(input, mode, (fraction) => {
        setDownloadProgress(fraction);
      });
      setDownloadProgress(null);
      setTriage(outcome.triage);
      setTriageMeta(outcome.meta);
      setTriageTruncated(outcome.inputTruncated);
      const entry: HistoryEntry = {
        id: `${Date.now()}`,
        time: Date.now(),
        input,
        triage: outcome.triage,
        triageMeta: outcome.meta,
        diagnosis: null,
        diagnosisMeta: null,
      };
      currentEntryId.current = entry.id;
      persistHistory([entry, ...loadHistory()]);
    } catch (err) {
      setDownloadProgress(null);
      setTriageError(err instanceof Error ? err.message : "Triage failed. Try again.");
    } finally {
      setTriageBusy(false);
    }
  }, [input, mode, triageBusy, persistHistory]);

  const handleDiagnosis = useCallback(async () => {
    if (!triage || diagnosisBusy) return;
    setDiagnosisBusy(true);
    setDiagnosisError(null);
    setDiagnosis("");
    setDiagnosisMeta(null);
    try {
      const outcome = await runDiagnosis(input, triage, (partial) => {
        setDiagnosis(partial);
      });
      setDiagnosis(outcome.text);
      setDiagnosisMeta(outcome.meta);
      if (currentEntryId.current) {
        persistHistory(
          loadHistory().map((entry) =>
            entry.id === currentEntryId.current
              ? { ...entry, diagnosis: outcome.text, diagnosisMeta: outcome.meta }
              : entry,
          ),
        );
      }
    } catch (err) {
      setDiagnosisError(err instanceof Error ? err.message : "Diagnosis failed. Try again.");
    } finally {
      setDiagnosisBusy(false);
    }
  }, [input, triage, diagnosisBusy, persistHistory]);

  const restoreEntry = useCallback((entry: HistoryEntry) => {
    currentEntryId.current = entry.id;
    setInput(entry.input);
    setTriage(entry.triage);
    setTriageMeta(entry.triageMeta);
    setTriageError(null);
    setTriageTruncated(false);
    setDiagnosis(entry.diagnosis);
    setDiagnosisMeta(entry.diagnosisMeta);
    setDiagnosisError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const copyText = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
    } catch {
      setCopied(null);
    }
  }, []);

  const inputTooLong = input.length > TRIAGE_MAX_CHARS;

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Triage Copilot</h1>
          <p className="tagline">
            Paste logs or describe an incident. On-device AI triages it in seconds;
            the cloud writes the full diagnosis.
          </p>
        </div>
        <div className="status-pills">
          <span className={`pill ${firebaseConfigured ? "pill-ok" : "pill-warn"}`}>
            {firebaseConfigured ? "Firebase connected" : "Firebase not configured"}
          </span>
          <span className="pill">
            App Check:{" "}
            {appCheckMode === "recaptcha"
              ? "reCAPTCHA Enterprise"
              : appCheckMode === "debug"
                ? "debug token"
                : "not set"}
          </span>
          <span className={`pill ${device === "available" ? "pill-ok" : ""}`}>
            {DEVICE_LABELS[device]}
          </span>
        </div>
      </header>

      {!firebaseConfigured && (
        <section className="notice">
          <strong>Setup needed:</strong> this deployment has no Firebase config yet.
          Copy <code>.env.example</code> to <code>.env</code> and fill in the Firebase
          web app values, then restart. See the README for the console steps.
        </section>
      )}

      <main className="layout">
        <section className="panel input-panel">
          <h2>1. Describe the incident</h2>
          <p className="hint">
            Paste logs, an alert, or a plain description. Triage reads the first{" "}
            {TRIAGE_MAX_CHARS.toLocaleString()} characters on-device.
          </p>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={"Example: payments-api pods crash-looping after the 14:02 deploy. Users see 502 errors on checkout.\n\nkubectl describe pod: Last State: Terminated, Reason: OOMKilled, Exit Code: 137…"}
            rows={14}
            aria-label="Incident report or logs"
          />
          <div className="input-footer">
            <span className={inputTooLong ? "count count-over" : "count"}>
              {input.length.toLocaleString()} characters
              {inputTooLong ? ` — triage uses the first ${TRIAGE_MAX_CHARS.toLocaleString()}` : ""}
            </span>
            <button
              className="button button-secondary"
              onClick={() => {
                setInput("");
                setTriage(null);
                setTriageMeta(null);
                setDiagnosis(null);
                setDiagnosisMeta(null);
                setTriageError(null);
                setDiagnosisError(null);
              }}
            >
              Clear
            </button>
          </div>

          <div className="samples">
            <span className="samples-label">Try a sample:</span>
            {SAMPLE_INCIDENTS.map((sample) => (
              <button
                key={sample.id}
                className="chip"
                onClick={() => {
                  setInput(sample.body);
                  setTriage(null);
                  setTriageMeta(null);
                  setDiagnosis(null);
                  setDiagnosisMeta(null);
                  setTriageError(null);
                  setDiagnosisError(null);
                }}
              >
                {sample.title}
              </button>
            ))}
          </div>

          <fieldset className="mode-picker">
            <legend>Triage runs</legend>
            {(Object.keys(MODE_LABELS) as TriageMode[]).map((m) => (
              <label key={m} className="mode-option">
                <input
                  type="radio"
                  name="triage-mode"
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                />
                {MODE_LABELS[m]}
              </label>
            ))}
          </fieldset>
          <p className="hint">
            On-device triage keeps your logs on this device. Cloud fallback only
            runs when the on-device model is not available.
          </p>

          <button
            className="button button-primary triage-button"
            onClick={handleTriage}
            disabled={!input.trim() || triageBusy || !firebaseConfigured}
          >
            {triageBusy ? "Triaging…" : "Triage this incident"}
          </button>
          {downloadProgress !== null && downloadProgress < 1 && (
            <div className="download">
              <div className="download-bar">
                <div
                  className="download-fill"
                  style={{ width: `${Math.round(downloadProgress * 100)}%` }}
                />
              </div>
              <span>Downloading on-device model… {Math.round(downloadProgress * 100)}%</span>
            </div>
          )}
          {triageError && <p className="error">{triageError}</p>}
        </section>

        <section className="panel results-panel">
          <h2>2. Triage</h2>
          {!triage && !triageBusy && (
            <p className="empty">
              No triage yet. Paste an incident and press “Triage this incident”.
            </p>
          )}
          {triageBusy && !triage && <p className="empty">Working through the incident…</p>}
          {triage && triageMeta && (
            <div className="triage-card">
              <div className="triage-head">
                <span className={severityClass(triage.severity)}>{triage.severity}</span>
                <span className="category">{triage.category}</span>
                <span className="component">{triage.component}</span>
              </div>
              <p className="summary">{triage.summary}</p>
              <div className="confidence">
                <span>Confidence {Math.round(triage.confidence * 100)}%</span>
                <div className="confidence-bar">
                  <div
                    className="confidence-fill"
                    style={{ width: `${Math.round(triage.confidence * 100)}%` }}
                  />
                </div>
              </div>
              {triage.signals.length > 0 && (
                <>
                  <h3>Signals</h3>
                  <ul className="signals">
                    {triage.signals.map((signal, idx) => (
                      <li key={idx}>{signal}</li>
                    ))}
                  </ul>
                </>
              )}
              <PathBadge meta={triageMeta} />
              {triageTruncated && (
                <p className="hint">
                  Note: triage read the first {TRIAGE_MAX_CHARS.toLocaleString()} characters
                  of a longer report.
                </p>
              )}
              <button
                className="button button-secondary"
                onClick={() => copyText("triage", JSON.stringify(triage, null, 2))}
              >
                {copied === "triage" ? "Copied" : "Copy triage JSON"}
              </button>
            </div>
          )}

          <h2>3. Full diagnosis</h2>
          {!triage && (
            <p className="empty">Run triage first, then the cloud writes the full diagnosis.</p>
          )}
          {triage && !diagnosis && (
            <button
              className="button button-primary"
              onClick={handleDiagnosis}
              disabled={diagnosisBusy || !firebaseConfigured}
            >
              {diagnosisBusy ? "Writing diagnosis…" : "Get full diagnosis (cloud)"}
            </button>
          )}
          {diagnosisError && <p className="error">{diagnosisError}</p>}
          {diagnosis !== null && diagnosis !== "" && (
            <div className="diagnosis">
              {renderMarkdown(diagnosis)}
              {diagnosisMeta && <PathBadge meta={diagnosisMeta} />}
              {!diagnosisBusy && (
                <button
                  className="button button-secondary"
                  onClick={() => copyText("diagnosis", diagnosis)}
                >
                  {copied === "diagnosis" ? "Copied" : "Copy diagnosis"}
                </button>
              )}
            </div>
          )}
          {diagnosisBusy && diagnosis === "" && (
            <p className="empty">The cloud model is writing…</p>
          )}
        </section>
      </main>

      <section className="panel history-panel">
        <h2>Recent triages</h2>
        {history.length === 0 ? (
          <p className="empty">Nothing yet. Past triages are kept on this device only.</p>
        ) : (
          <ul className="history-list">
            {history.map((entry) => (
              <li key={entry.id}>
                <button className="history-item" onClick={() => restoreEntry(entry)}>
                  <span className={severityClass(entry.triage.severity)}>
                    {entry.triage.severity}
                  </span>
                  <span className="history-summary">{entry.triage.summary}</span>
                  <span className="history-meta">
                    {new Date(entry.time).toLocaleString()} ·{" "}
                    {entry.triageMeta.path === "on_device" ? "on-device" : "cloud"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel how-panel">
        <h2>How the hybrid inference works</h2>
        <ol className="how-list">
          <li>
            <strong>Fast triage, on-device when possible.</strong> The triage step uses
            Firebase AI Logic with <code>prefer_on_device</code> mode. On Chrome for
            desktop with Gemini Nano available, the classification runs locally: no
            logs leave the device, and it works offline. When the model is not
            available, the same call falls back to the cloud model.
          </li>
          <li>
            <strong>Deep diagnosis in the cloud.</strong> The full diagnosis is a
            longer, higher-context job, so it runs on the cloud Gemini model through
            the same Firebase AI Logic SDK, streamed as it is written.
          </li>
          <li>
            <strong>Every result says where it ran.</strong> Each card shows whether
            inference ran on-device or in the cloud, which model answered, and how
            long it took. Nothing is guessed: the path comes from the SDK response.
          </li>
          <li>
            <strong>App Check protects the API.</strong> Firebase App Check is
            enforced for AI Logic, with reCAPTCHA Enterprise on the deployment
            and debug tokens for local development.
          </li>
        </ol>
        <p className="hint">
          Built for the #BuildHybridAI 2026 hackathon. Source code is open source
          under the Apache 2.0 license.
        </p>
      </section>

      <footer className="footer">
        Triage Copilot · incident triage with Firebase AI Logic hybrid inference ·
        your incident text is only sent to the cloud when the cloud path runs.
      </footer>
    </div>
  );
}
