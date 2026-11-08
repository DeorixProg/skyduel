// Runs client/tools/worker-bench.html in Chrome (Vite dev on :5173) and saves the result.
import fs from "node:fs";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "chrome", args: ["--mute-audio"] });
const page = await browser.newPage();
await page.goto("http://localhost:5173/tools/worker-bench.html");
const rows = await page
  .waitForFunction(() => window.__bench, null, { timeout: 120000 })
  .then((h) => h.jsonValue());
fs.writeFileSync("docs/lab07/worker.json", JSON.stringify(rows, null, 2));
console.table(rows);
await browser.close();
