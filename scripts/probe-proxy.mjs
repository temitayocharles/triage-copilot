// Probe: can Playwright's Chromium reach the internet via the local proxy?
// Requires: node scripts/local-proxy.mjs 8888 running.
import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  proxy: { server: "http://127.0.0.1:8888", bypass: "localhost,127.0.0.1" },
  args: ["--no-sandbox"],
});
// The egress proxy re-signs TLS with its own CA (Hatch Sandbox Egress CA),
// which Chromium's trust store does not include. This is a throwaway test
// browser, so certificate errors are ignored here only.
const context = await browser.newContext({ ignoreHTTPSErrors: true });
for (const target of [
  "https://example.com",
  "https://www.google.com",
  "https://firebasevertexai.googleapis.com/",
]) {
  const page = await context.newPage();
  try {
    const resp = await page.goto(target, { timeout: 30000 });
    console.log(`${target} -> HTTP ${resp.status()}`);
  } catch (e) {
    console.log(`${target} -> FAILED: ${e.message.split("\n")[0]}`);
  }
  await page.close();
}
await browser.close();
