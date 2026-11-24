// End-to-end test against the live Firebase project (dev server, debug token).
// Runs sample 1 through triage + cloud diagnosis.
// Usage: npm run dev (port 5173) then: node scripts/e2e.mjs [url]
// MODE=cloud skips the on-device attempt and triages cloud-only (this VM
// cannot run Gemini Nano: the egress proxy blocks optimizationguide-pa
// .googleapis.com and the VM has 8 GB RAM vs the 16 GB requirement).
// Writes JSON summary to stdout and screenshots to /tmp/triage-e2e/.
//
// NOTE: this VM reaches the internet through an authenticated egress proxy
// (HTTPS_PROXY). Chromium cannot authenticate to it (embedded credentials in
// --proxy-server are ignored; Playwright's proxy auth fails the CONNECT
// tunnel). So the browser goes through scripts/local-proxy.mjs, a tiny local
// no-auth forward proxy on 127.0.0.1:8888 that adds the upstream credentials.
// Start it first: node scripts/local-proxy.mjs 8888
// The egress proxy also re-signs TLS with its own CA, which Chromium's trust
// store does not include, so this throwaway test browser ignores cert errors.
import { chromium } from "playwright";
import fs from "node:fs";

const url = process.argv[2] || "http://localhost:5173/";
const outDir = "/tmp/triage-e2e";
fs.mkdirSync(outDir, { recursive: true });

const errors = [];
const log = (...a) => console.log(new Date().toISOString(), ...a);

const context = await chromium.launchPersistentContext("/tmp/triage-chrome-profile", {
  headless: true,
  viewport: { width: 1280, height: 900 },
  proxy: { server: "http://127.0.0.1:8888", bypass: "localhost,127.0.0.1" },
  ignoreHTTPSErrors: true,
  args: ["--no-sandbox"],
});
const page = context.pages()[0] || (await context.newPage());
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (err) => errors.push(String(err)));

const started = Date.now();
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

const pills = await page.locator(".pill").allTextContents();
log("pills:", JSON.stringify(pills));

// Browser egress check: can the page reach the internet through the proxy?
const egress = await page
  .evaluate(async () => {
    try {
      const r = await fetch("https://www.google.com/generate_204", { mode: "no-cors" });
      return `fetch ok (opaque, status ${r.status})`;
    } catch (e) {
      return `fetch FAILED: ${e.message}`;
    }
  })
  .catch((e) => `eval-error: ${e.message}`);
log("browser egress:", egress);

const deviceAvailability = await page
  .evaluate(() => (typeof LanguageModel === "undefined" ? "no-api" : LanguageModel.availability()))
  .catch((e) => `eval-error: ${e.message}`);
log("LanguageModel.availability():", deviceAvailability);

// Click sample 1 and run triage.
await page.locator(".chip").first().click();
await page.waitForTimeout(500);

const cloudOnly = process.env.MODE === "cloud";
if (cloudOnly) {
  await page.locator('input[name="triage-mode"][value="only_in_cloud"]').click();
  log("MODE=cloud: triaging cloud-only");
}

const triageOutcome = { badge: null, meta: null, seconds: null, head: null, summary: null, error: null };
const triageStart = Date.now();
await page.locator(".triage-button").click();
log(`triage started (${cloudOnly ? "cloud-only" : "prefer on-device"}), waiting for result...`);

let lastProgress = "";
const poll = setInterval(async () => {
  const dl = await page.locator(".download span").textContent().catch(() => null);
  if (dl && dl !== lastProgress) {
    lastProgress = dl;
    log("  download:", dl);
  }
}, 10000);

try {
  // Race the result card against an error message so failures surface fast
  // instead of burning the whole timeout.
  await Promise.race([
    page.locator(".triage-card").waitFor({ timeout: 20 * 60 * 1000 }),
    page.locator(".error").first().waitFor({ timeout: 20 * 60 * 1000 }).then(() => {
      throw new Error("triage showed an error on the page");
    }),
  ]);
  triageOutcome.seconds = Math.round((Date.now() - triageStart) / 1000);
  triageOutcome.badge = await page.locator(".triage-card .badge").textContent();
  triageOutcome.meta = await page.locator(".triage-card .meta-text").allTextContents();
  triageOutcome.head = await page.locator(".triage-card .triage-head").innerText();
  triageOutcome.summary = await page.locator(".triage-card .summary").textContent();
  log(`triage done in ${triageOutcome.seconds}s:`, triageOutcome.badge, "|", triageOutcome.meta.join(" | "));
} catch (e) {
  clearInterval(poll);
  triageOutcome.error = `triage did not complete: ${e.message.split("\n")[0]}`;
  const errText = await page.locator(".error").first().textContent().catch(() => null);
  const dlText = await page.locator(".download span").textContent().catch(() => null);
  log("TRIAGE FAILED:", triageOutcome.error, "| page error:", errText, "| download:", dlText);
  log("console errors so far:", JSON.stringify(errors.slice(0, 5)));
  await page.screenshot({ path: `${outDir}/triage-failed.png`, fullPage: true });
  // Fall back to cloud-only triage so the cloud path still gets validated.
  log("retrying triage in cloud-only mode...");
  await page.locator('input[name="triage-mode"][value="only_in_cloud"]').click();
  await page.locator(".triage-button").click();
  try {
    await page.locator(".triage-card").waitFor({ timeout: 5 * 60 * 1000 });
    triageOutcome.seconds = Math.round((Date.now() - triageStart) / 1000);
    triageOutcome.badge = await page.locator(".triage-card .badge").textContent();
    triageOutcome.meta = await page.locator(".triage-card .meta-text").allTextContents();
    triageOutcome.head = await page.locator(".triage-card .triage-head").innerText();
    triageOutcome.summary = await page.locator(".triage-card .summary").textContent();
    log("cloud-only triage done:", triageOutcome.badge, "|", triageOutcome.meta.join(" | "));
  } catch (e2) {
    triageOutcome.error += ` | cloud-only retry also failed: ${e2.message.split("\n")[0]}`;
    log("CLOUD-ONLY TRIAGE ALSO FAILED:", e2.message.split("\n")[0]);
    log("console errors:", JSON.stringify(errors.slice(0, 8)));
  }
} finally {
  clearInterval(poll);
}
await page.screenshot({ path: `${outDir}/triage.png`, fullPage: true });

// Run the cloud diagnosis (only possible if triage produced a result).
const diagnosisOutcome = { badge: null, meta: null, seconds: null, chars: null, error: null };
if (await page.locator(".triage-card").count()) {
  await page.getByRole("button", { name: /Get full diagnosis/ }).click();
  log("diagnosis started, waiting for streaming to finish...");
  const diagStart = Date.now();
  try {
    // The free tier can take minutes to first token under load (231s seen
    // Nov 24), so give the diagnosis 10 minutes.
    await Promise.race([
      page.locator(".diagnosis .badge").waitFor({ timeout: 10 * 60 * 1000 }),
      page.locator(".error").last().waitFor({ timeout: 10 * 60 * 1000 }).then(() => {
        throw new Error("diagnosis showed an error on the page");
      }),
    ]);
    diagnosisOutcome.seconds = Math.round((Date.now() - diagStart) / 1000);
    diagnosisOutcome.badge = await page.locator(".diagnosis .badge").textContent();
    diagnosisOutcome.meta = await page.locator(".diagnosis .meta-text").allTextContents();
    const diagText = await page.locator(".diagnosis").innerText();
    diagnosisOutcome.chars = diagText.length;
    diagnosisOutcome.headings = (diagText.match(/What happened|Likely root cause|Evidence|Fix now|Verify the fix|Prevent next time/g) || []).length;
    log(`diagnosis done in ${diagnosisOutcome.seconds}s:`, diagnosisOutcome.badge, "|", diagnosisOutcome.meta.join(" | "), `| ${diagnosisOutcome.chars} chars, ${diagnosisOutcome.headings}/6 headings`);
  } catch (e) {
    diagnosisOutcome.error = `diagnosis did not complete: ${e.message.split("\n")[0]}`;
    const errText = await page.locator(".error").last().textContent().catch(() => null);
    log("DIAGNOSIS FAILED:", diagnosisOutcome.error, "| page error:", errText);
    log("console errors:", JSON.stringify(errors.slice(0, 8)));
  }
  await page.screenshot({ path: `${outDir}/diagnosis.png`, fullPage: true });
} else {
  diagnosisOutcome.error = "skipped: no triage result";
  log("diagnosis skipped: no triage result");
}

const summary = {
  url,
  totalSeconds: Math.round((Date.now() - started) / 1000),
  pills,
  egress,
  deviceAvailability,
  triage: triageOutcome,
  diagnosis: diagnosisOutcome,
  consoleErrors: errors,
};
fs.writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
await context.close();
const failed = triageOutcome.error || diagnosisOutcome.error || errors.length;
process.exit(failed ? 1 : 0);
