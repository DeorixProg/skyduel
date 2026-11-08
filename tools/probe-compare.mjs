import { stepHashes } from "@skyduel/shared/determinism.js";
import { chromium } from "playwright-core";
import { probe } from "../client/tools/mathprobe.js";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
await page.goto("http://localhost:5173/tools/mathprobe.html");
const b = await page.waitForFunction(() => window.__probe).then((h) => h.jsonValue());
await browser.close();
const n = { math: probe(), steps: stepHashes() };
console.log("node v8", process.versions.v8, "| chrome", browser.version?.() ?? "");
for (const k of Object.keys(n.math))
  console.log(
    k.padEnd(6),
    n.math[k] === b.math[k] ? "same" : `DIFF node ${n.math[k]} chrome ${b.math[k]}`,
  );
const first = n.steps.findIndex((h, i) => h !== b.steps[i]);
console.log("first diverging sample:", first, "(step", first * 10, ")");
