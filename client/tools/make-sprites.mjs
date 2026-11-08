// Usage: npm run dev (port 5173) and then: node tools/make-sprites.mjs
import fs from "node:fs";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
await page.goto("http://localhost:5173/tools/make-sprites.html");
const { png, atlas } = await page.waitForFunction(() => window.__sheet).then((h) => h.jsonValue());
fs.writeFileSync("public/assets/sprites/sheet.png", Buffer.from(png.split(",")[1], "base64"));
fs.writeFileSync("public/assets/sprites/sheet.json", `${JSON.stringify(atlas, null, 2)}\n`);
console.log("frames:", Object.keys(atlas.frames).length);
await browser.close();
