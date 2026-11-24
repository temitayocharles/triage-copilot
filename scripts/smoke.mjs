// Smoke test: load the built app, report console errors, take a screenshot.
// Usage: npm run build && (npm run preview &) && node scripts/smoke.mjs [url]
import { chromium } from "playwright";

const url = process.argv[2] || "http://localhost:4173/";
const shotPath = process.argv[3] || "/tmp/triage-smoke.png";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (err) => errors.push(String(err)));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const heading = await page.locator("h1").first().textContent().catch(() => null);
const notice = await page.locator(".notice").count();
const pills = await page.locator(".pill").allTextContents();
await page.screenshot({ path: shotPath, fullPage: true });

console.log(JSON.stringify({ heading, noticeVisible: notice > 0, pills, errors }, null, 2));
await browser.close();
process.exit(errors.length ? 1 : 0);
