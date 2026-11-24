// Records the demo video (max 3 min) with Playwright video capture.
// Usage: node scripts/record-demo.mjs [url]  (default http://localhost:5173/)
// Output: /tmp/triage-video/demo-<timestamp>.webm
// Requires the local proxy (scripts/local-proxy.mjs) for browser egress.
import { chromium } from "playwright";
import fs from "node:fs";

const url = process.argv[2] || "http://localhost:5173/";
const outDir = "/tmp/triage-video";
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const browser = await chromium.launch({
  // Bypass the proxy for localhost: the local proxy only tunnels CONNECT
  // (HTTPS); a plain-HTTP localhost request through it hangs forever.
  proxy: { server: "http://127.0.0.1:8888", bypass: "localhost,127.0.0.1" },
  args: ["--ignore-certificate-errors"],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  ignoreHTTPSErrors: true,
  recordVideo: { dir: outDir, size: { width: 1280, height: 720 } },
});
const page = await context.newPage();
page.on("pageerror", (e) => log("page error:", e.message.split("\n")[0]));

const started = Date.now();
// try/finally: the context MUST close even on timeout, or Playwright never
// finalizes the video file and the webm is truncated/unplayable.
try {
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.locator(".pill").first().waitFor({ timeout: 60000 });
log("loaded, pausing on landing state");
await sleep(3000);

// Pick the sample incident, then select "Cloud only": this VM's Chromium has
// a stub Prompt API that reports the model "downloadable" and the SDK's
// initializeDeviceModel waits forever for a download that never comes, so
// "Prefer on-device" hangs here. The cloud path is what this video shows;
// the on-device segment must be recorded on a capable machine.
await page.getByRole("button", { name: /Deploy crash loop/ }).click();
log("sample selected");
await sleep(1500);
await page.locator('input[name="triage-mode"][value="only_in_cloud"]').click();
log("mode: cloud only");
await sleep(1500);

// Triage. (The card's class is .triage-card, not .result.)
await page.getByRole("button", { name: /Triage this incident/ }).click();
log("triage started");
await Promise.race([
  page.locator(".triage-card").waitFor({ timeout: 10 * 60 * 1000 }),
  page.locator(".error").first().waitFor({ timeout: 10 * 60 * 1000 }).then(() => {
    throw new Error("triage showed an error on the page");
  }),
]);
const badge = await page.locator(".triage-card .badge").textContent();
log("triage done:", badge, `(${Math.round((Date.now() - started) / 1000)}s)`);
// The Triage-button click scrolled the page down; bring the full card
// (P1 badge + summary at its top) back into view for the camera.
await page.locator(".triage-card").scrollIntoViewIfNeeded();
await sleep(4000);

// Diagnosis.
await page.locator("h2", { hasText: "Full diagnosis" }).scrollIntoViewIfNeeded();
await sleep(1000);
await page.getByRole("button", { name: /Get full diagnosis/ }).click();
log("diagnosis started");
await Promise.race([
  page.locator(".diagnosis .badge").waitFor({ timeout: 10 * 60 * 1000 }),
  page.locator(".error").last().waitFor({ timeout: 10 * 60 * 1000 }).then(() => {
    throw new Error("diagnosis showed an error on the page");
  }),
]);
log("diagnosis done", `(${Math.round((Date.now() - started) / 1000)}s)`);
await sleep(2000);

// Slow scroll through the diagnosis, then the explainer section.
await page.evaluate(async () => {
  const step = async (y) => {
    window.scrollTo({ top: y, behavior: "smooth" });
    await new Promise((r) => setTimeout(r, 1800));
  };
  const max = document.body.scrollHeight - window.innerHeight;
  for (let y = 800; y < max; y += 800) await step(y);
  await step(max);
});
await sleep(3000);

log(`total ${Math.round((Date.now() - started) / 1000)}s, closing`);
} catch (e) {
  log("RECORDING FAILED:", e.message.split("\n")[0]);
} finally {
  await context.close();
  await browser.close();
}
const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".webm"));
console.log("video files:", files);
