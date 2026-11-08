import fs from "node:fs";
import { chromium } from "playwright-core";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: ["--window-size=1280,760"],
  ignoreDefaultArgs: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const out = {};
for (const exp of ["none", "interval"]) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`http://localhost:4173/?exp=${exp}`);
  await sleep(2000);
  await page.evaluate(() => {
    window.__vis = [];
    document.addEventListener("visibilitychange", () =>
      window.__vis.push([document.visibilityState, Math.round(performance.now())]),
    );
    window.__game.recorder.reset();
  });
  await sleep(10000);
  const fg = await page.evaluate(() => window.__game.recorder.summary());
  const st0 = await page.evaluate(() => window.__game.loop.stats.totalSteps);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await page.evaluate(() => window.__game.recorder.reset());
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
  await sleep(5000);
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  await sleep(1500);
  const r = await page.evaluate(() => ({
    s: window.__game.recorder.summary(),
    vis: window.__vis,
    big: window.__game.recorder.frames.filter((f) => f > 50).map(Math.round),
    steps: window.__game.loop.stats.totalSteps,
    fpsAfter: window.__game.loop.stats.framesPerSec,
  }));
  r.steps -= st0;
  out[exp] = { fg, ...r };
  console.log(exp, JSON.stringify(out[exp]));
  await page.close();
}
fs.writeFileSync("docs/lab01/background.json", JSON.stringify(out, null, 2));
await browser.close();
