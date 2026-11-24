// Dump chrome://on-device-internals to learn why Gemini Nano is unavailable.
// Usage: node scripts/probe-internals.mjs
import { chromium } from "playwright";

const context = await chromium.launchPersistentContext("/tmp/triage-realchrome-profile", {
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--ignore-certificate-errors"],
});
const page = context.pages()[0] || (await context.newPage());
await page.goto("chrome://on-device-internals/", { waitUntil: "networkidle" }).catch((e) => console.log("goto failed:", e.message));
await page.waitForTimeout(3000);
const text = await page.evaluate(() => document.body.innerText).catch((e) => `eval failed: ${e.message}`);
console.log("=== chrome://on-device-internals ===");
console.log(text.slice(0, 6000));
await context.close();
