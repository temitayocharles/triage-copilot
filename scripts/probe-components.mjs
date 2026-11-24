// Force the Optimization Guide on-device model component download via
// chrome://components, then re-check Prompt API availability.
// Usage: node scripts/probe-components.mjs
import { chromium } from "playwright";

const context = await chromium.launchPersistentContext("/tmp/triage-realchrome-profile", {
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  ignoreDefaultArgs: ["--disable-component-update", "--disable-background-networking"],
  proxy: { server: "http://127.0.0.1:8888", bypass: "localhost,127.0.0.1" },
  ignoreHTTPSErrors: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--ignore-certificate-errors"],
});
const page = context.pages()[0] || (await context.newPage());

await page.goto("chrome://components/", { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
let text = await page.evaluate(() => document.body.innerText).catch(() => "");
console.log("=== chrome://components (on-device lines) ===");
const lines = text.split("\n").filter((l) => /device|optimization|model/i.test(l));
console.log(lines.length ? lines.join("\n") : "(no on-device component listed yet)");

// Click every "Check for update" button (shadow DOM: use the page's own JS).
const clicked = await page.evaluate(() => {
  let n = 0;
  const roots = [document];
  const walk = (root) => {
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) walk(el.shadowRoot);
    });
  };
  walk(document);
  document.querySelectorAll("button").forEach((b) => {
    if (/check for update/i.test(b.textContent || "")) { b.click(); n++; }
  });
  // WebUI components page nests buttons in shadow roots; also try those.
  const all = [];
  const collect = (root) => {
    root.querySelectorAll("*").forEach((el) => {
      all.push(el);
      if (el.shadowRoot) collect(el.shadowRoot);
    });
  };
  collect(document);
  all.forEach((el) => {
    if (el.tagName === "BUTTON" && /check for update/i.test(el.textContent || "")) { el.click(); n++; }
  });
  return n;
});
console.log(`clicked ${clicked} "Check for update" button(s); waiting 90s for downloads...`);
await page.waitForTimeout(90000);

await page.goto("chrome://components/", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
text = await page.evaluate(() => document.body.innerText).catch(() => "");
const lines2 = text.split("\n").filter((l) => /device|optimization|model/i.test(l));
console.log("=== components after wait ===");
console.log(lines2.length ? lines2.join("\n") : "(no on-device component listed)");

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const avail = await page.evaluate(() => LanguageModel.availability());
console.log("LanguageModel.availability() after component check:", avail);
await context.close();
