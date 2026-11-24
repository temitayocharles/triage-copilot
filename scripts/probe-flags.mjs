// Dump the chrome://flags entries for the on-device model flags.
// Usage: node scripts/probe-flags.mjs
import { chromium } from "playwright";

const context = await chromium.launchPersistentContext("/tmp/triage-realchrome-profile", {
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--ignore-certificate-errors"],
});
const page = context.pages()[0] || (await context.newPage());
await page.goto("chrome://flags/#optimization-guide-on-device-model", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
const text = await page.evaluate(() => document.body.innerText).catch((e) => `eval failed: ${e.message}`);
console.log("=== flags page (filtered) ===");
for (const line of text.split("\n")) {
  if (/device|optimization|on-device|perf|nano|language.?model/i.test(line)) console.log(line);
}
await page.goto("chrome://version/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const version = await page.evaluate(() => document.body.innerText).catch((e) => `eval failed: ${e.message}`);
const cmdline = version.split("\n").find((l) => l.startsWith("Command Line")) || "";
console.log("=== version command line ===");
console.log(cmdline.slice(0, 2000));
await context.close();
