// Direct Prompt API diagnostic: bypasses the Firebase SDK to see whether the
// Gemini Nano model actually downloads and runs in this browser.
// Usage: CHROME_PATH=/usr/bin/google-chrome node scripts/probe-nano.mjs
// (dev server + local proxy running). CHROME_PROFILE sets the user data dir.
// NOTE: Playwright's bundled Chromium has a STUB Prompt API that echoes input
// ("On-device model is not available in Chromium"). Only real Google Chrome
// downloads and runs Gemini Nano.
import { chromium } from "playwright";

const executablePath = process.env.CHROME_PATH || undefined;
const userDataDir = process.env.CHROME_PROFILE || "/tmp/triage-chrome-profile";
const headed = process.env.HEADED === "1";
console.log("browser:", executablePath || "playwright chromium", "| profile:", userDataDir, "| headed:", headed);

const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  // Playwright disables the component updater by default, which makes the
  // Gemini Nano download impossible. Re-enable it (and background networking,
  // which the updater and variations seed need).
  ignoreDefaultArgs: ["--disable-component-update", "--disable-background-networking"],
  headless: !headed,
  viewport: { width: 1280, height: 900 },
  proxy: { server: "http://127.0.0.1:8888", bypass: "localhost,127.0.0.1" },
  ignoreHTTPSErrors: true,
  // --ignore-certificate-errors is browser-level: it also covers the
  // component updater (which downloads Gemini Nano) behind the MITM proxy.
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--ignore-certificate-errors"],
});
const page = context.pages()[0] || (await context.newPage());
page.on("console", (m) => {
  if (m.type() === "error") console.log("PAGE ERROR:", m.text());
});
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });

const before = await page.evaluate(() => LanguageModel.availability());
console.log(new Date().toISOString(), "availability before:", before);

// Start session creation with a download monitor, log progress events.
const result = await page.evaluate(async () => {
  const events = [];
  const log = (e) => events.push(`${((performance.now() / 1000) | 0)}s ${e}`);
  try {
    const session = await LanguageModel.create({
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          log(`downloadprogress loaded=${e.loaded} total=${e.total}`);
        });
      },
    });
    log("session created");
    const out = await session.prompt("Reply with exactly: NANO OK");
    log(`prompt replied: ${JSON.stringify(out)}`);
    return { ok: true, events };
  } catch (e) {
    log(`FAILED: ${e.name}: ${e.message}`);
    return { ok: false, events };
  }
}, { timeout: 20 * 60 * 1000 });

for (const e of result.events) console.log(e);
console.log("RESULT:", result.ok ? "ON-DEVICE WORKS" : "ON-DEVICE FAILED");
const after = await page.evaluate(() => LanguageModel.availability());
console.log("availability after:", after);
await context.close();
process.exit(result.ok ? 0 : 1);
