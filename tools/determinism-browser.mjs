// Runs shared/src/determinism.js in Chrome (via the Vite dev server) and prints the hash.
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
await page.goto("http://localhost:5173/tools/determinism.html");
console.log(
  "chrome",
  JSON.stringify(await page.waitForFunction(() => window.__det).then((h) => h.jsonValue())),
);
await browser.close();
