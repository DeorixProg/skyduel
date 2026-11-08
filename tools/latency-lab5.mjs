// Input-to-screen latency: press a turn key, measure when the DISPLAYED own ship starts turning.
// Usage: node tools/latency-lab5.mjs "<query>"
import { chromium } from "playwright-core";

const q = process.argv[2] ?? "lag=100";
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto(`http://localhost:8080/?${q}`);
await page.waitForSelector("#lobby .room");
await page.click('#lobby .room[data-id="night"]');
await page.click("#join");
await page.waitForFunction(() => window.__game?.own);
await page.waitForTimeout(1500);
const results = [];
for (let i = 0; i < 10; i++) {
  const ms = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const a0 = window.__game.own.angle;
        const t0 = performance.now();
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD" }));
        const poll = () => {
          if (Math.abs(window.__game.own.angle - a0) > 1e-3) {
            window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD" }));
            resolve(performance.now() - t0);
          } else requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      }),
  );
  results.push(ms);
  await page.waitForTimeout(400);
}
results.sort((a, b) => a - b);
console.log(
  q,
  "median",
  results[5].toFixed(0),
  "ms; all:",
  results.map((x) => x.toFixed(0)).join(" "),
);
await browser.close();
