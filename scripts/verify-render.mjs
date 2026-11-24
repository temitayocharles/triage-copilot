// Deterministic check for the diagnosis markdown renderer (no model call).
// Seeds a history entry whose diagnosis mimics real model output — numbered
// steps with code blocks indented under them — then restores it and asserts:
//   1. fenced code blocks render as <pre>, never as literal ``` text
//   2. ordered lists split by code blocks keep numbering (via ol start)
// Usage: npm run dev (port 5173) and node scripts/local-proxy.mjs 8888 first,
// then: node scripts/verify-render.mjs [url]
// Screenshot: /tmp/triage-e2e/render-fix.png
import { chromium } from "playwright";
import fs from "node:fs";

const url = process.argv[2] || "http://localhost:5173/";
const outDir = "/tmp/triage-e2e";
fs.mkdirSync(outDir, { recursive: true });

const DIAGNOSIS = [
  "## What happened",
  "The payments-api deployment is crash-looping after the 14:02 deploy and checkout returns 502 errors.",
  "",
  "## Likely root cause",
  "The new container image needs more memory than the pod limit allows, so Kubernetes kills it with OOMKilled.",
  "",
  "## Evidence",
  "- Pod logs show `Last State: Terminated, Reason: OOMKilled`",
  "- Exit code 137 on every restart",
  "",
  "## Fix now",
  "1. Restart the deployment:",
  "   ```bash",
  "   kubectl rollout restart deployment/payments-api",
  "   ```",
  "2. Watch the pods come back:",
  "   ```bash",
  "   kubectl get pods -l app=payments-api -w",
  "   ```",
  "3. Raise the memory limit if it OOMKills again.",
  "",
  "## Verify the fix",
  "1. Confirm all pods reach Running.",
  "2. Check checkout returns 200.",
  "",
  "## Prevent next time",
  "- Set memory requests and limits on every deployment.",
  "- Add an alert for OOMKilled restarts.",
].join("\n");

const entry = {
  id: "verify-render",
  time: Date.now(),
  input: "payments-api pods crash-looping after the 14:02 deploy.",
  triage: {
    severity: "P1",
    category: "deploy",
    component: "payments-api",
    summary: "payments-api pods crash-looping after the deploy.",
    confidence: 0.99,
    signals: ["OOMKilled", "Exit Code: 137"],
  },
  triageMeta: { path: "in_cloud", modelLabel: "Gemini 3.5 Flash-Lite (cloud)", latencyMs: 3200 },
  diagnosis: DIAGNOSIS,
  diagnosisMeta: { path: "in_cloud", modelLabel: "Gemini 3.5 Flash-Lite (cloud)", latencyMs: 2000 },
};

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const context = await chromium.launchPersistentContext("/tmp/triage-chrome-profile-render", {
  headless: true,
  viewport: { width: 1280, height: 900 },
  proxy: { server: "http://127.0.0.1:8888", bypass: "localhost,127.0.0.1" },
  ignoreHTTPSErrors: true,
  args: ["--no-sandbox"],
});
const page = context.pages()[0] || (await context.newPage());
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (err) => errors.push(String(err)));

// Seed history before the app mounts (it reads localStorage on first render).
await page.addInitScript((seed) => {
  localStorage.setItem("triage-copilot-history", JSON.stringify(seed));
}, [entry]);

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

await page.locator(".history-item").first().click();
await page.locator(".diagnosis").waitFor({ timeout: 15000 });
await page.locator(".diagnosis").scrollIntoViewIfNeeded();
await page.waitForTimeout(500);

const diag = page.locator(".diagnosis");
const diagText = await diag.innerText();
const preCount = await diag.locator("pre").count();
const preTexts = await diag.locator("pre code").allTextContents();
const olStarts = await diag.locator("ol").evaluateAll((ols) =>
  ols.map((ol) => Number(ol.getAttribute("start") ?? 1)),
);
const olItems = await diag.locator("ol li").allTextContents();

check("no literal code fences in rendered diagnosis", !diagText.includes("```"));
check("two code blocks render as <pre>", preCount === 2, `found ${preCount}`);
check(
  "first code block dedented to column 0",
  preTexts[0] === "kubectl rollout restart deployment/payments-api",
  JSON.stringify(preTexts[0]),
);
check(
  "ordered lists continue numbering across code blocks",
  JSON.stringify(olStarts) === JSON.stringify([1, 2, 3, 1]),
  `ol starts: ${JSON.stringify(olStarts)}`,
);
check(
  "all five numbered steps present",
  olItems.length === 5,
  `found ${olItems.length}: ${JSON.stringify(olItems)}`,
);
check("no console errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));

await diag.screenshot({ path: `${outDir}/render-fix.png` });
console.log(`screenshot: ${outDir}/render-fix.png`);
await context.close();
process.exit(failures.length ? 1 : 0);
