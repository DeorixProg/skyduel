import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://localhost:4173/";
const OUT = process.argv[3] ?? "out1";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--window-position=0,0",
    "--window-size=1280,760",
    "--disable-features=CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const results = {};

async function open(q) {
  const page = await ctx.newPage();
  await page.goto(BASE + q);
  await page.bringToFront();
  await sleep(1500);
  return page;
}
const summary = (page) => page.evaluate(() => window.__game.recorder.summary());
const reset = (page) => page.evaluate(() => window.__game.recorder.reset());
const stats = (page) => page.evaluate(() => ({ ...window.__game.loop.stats }));

// baseline + experiment 1
for (const exp of ["none", "block"]) {
  const page = await open(`?exp=${exp}`);
  await reset(page);
  const s0 = await stats(page);
  await sleep(10000);
  const s1 = await stats(page);
  results[exp] = { frames: await summary(page), steps10s: s1.totalSteps - s0.totalSteps, hud: s1 };
  await page.screenshot({ path: `${OUT}/${exp}.png` });
  await page.close();
}

// experiment 2: rAF vs setInterval, incl. 5 s in a background tab
for (const exp of ["none", "interval"]) {
  const page = await open(`?exp=${exp}`);
  await reset(page);
  await sleep(10000);
  const fg = await summary(page);
  const before = await stats(page);
  const other = await ctx.newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  const hiddenState = await page.evaluate(() => document.visibilityState);
  await reset(page);
  await sleep(5000);
  const bg = await summary(page);
  await page.bringToFront();
  await other.close();
  await sleep(500);
  const after = await stats(page);
  results[`bg_${exp}`] = {
    fg,
    bg,
    hiddenState,
    stepsDuringBg: after.totalSteps - before.totalSteps,
  };
  await page.close();
}

// experiment 3: fixed vs variable timestep, CPU throttle 1x and 6x
for (const exp of ["none", "variable"]) {
  for (const rate of [1, 6]) {
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    await page.goto(`${BASE}?exp=${exp}&autopilot=1`);
    await page.bringToFront();
    await page.waitForFunction(() => window.__autopilot, null, { timeout: 30000 });
    results[`ap_${exp}_${rate}x`] = await page.evaluate(() => ({
      ...window.__autopilot,
      frames: window.__game.recorder.summary(),
    }));
    await page.close();
  }
}

fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
await browser.close();
