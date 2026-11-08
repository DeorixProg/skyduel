// Lab 5: two browser windows in one match with an injected network.
// Usage: node tools/net-lab5.mjs "<extra query>" <seconds> <outPrefix> [video]
// The pilots are driven by scripted keyboard input, like a human would press keys.
import fs from "node:fs";
import { chromium } from "playwright-core";

const extra = process.argv[2] ?? "lag=100&jitter=30&drop=0.02";
const seconds = Number(process.argv[3] ?? 10);
const out = process.argv[4] ?? "docs/lab05/run";
const video = process.argv[5] === "video";
fs.mkdirSync("docs/lab05", { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--mute-audio"],
  headless: false,
});

async function pilot(name, x) {
  const ctx = await browser.newContext({
    viewport: { width: 800, height: 500 },
    ...(video
      ? { recordVideo: { dir: `${out}-video-${name}`, size: { width: 800, height: 500 } } }
      : {}),
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(name, "PAGEERROR", e.message));
  await page.goto(`http://localhost:8080/?${extra}`);
  await page.waitForSelector("#lobby .room");
  await page.fill("#pilot", name);
  await page.click('#lobby .room[data-id="somme"]');
  await page.click("#join");
  await page.waitForFunction(() => window.__game?.latest);
  return { page, ctx, name, x };
}

const a = await pilot("Maksym");
const b = await pilot("Sofiia");
const corr = { Maksym: [], Sofiia: [] };
const t0 = Date.now();
let step = 0;
// scripted dogfight: thrust most of the time, turns of varying length, bursts of fire
const plan = (p, i) => {
  const phase = (i + (p.name === "Sofiia" ? 7 : 0)) % 20;
  return {
    thrust: phase < 15,
    left: phase >= 4 && phase < 8,
    right: phase >= 12 && phase < 14,
    fire: phase % 3 === 0,
  };
};
const held = { Maksym: new Set(), Sofiia: new Set() };
async function apply(p, want) {
  const keys = { KeyW: want.thrust, KeyA: want.left, KeyD: want.right, Space: want.fire };
  for (const [k, on] of Object.entries(keys)) {
    if (on && !held[p.name].has(k)) {
      await p.page.keyboard.down(k);
      held[p.name].add(k);
    } else if (!on && held[p.name].has(k)) {
      await p.page.keyboard.up(k);
      held[p.name].delete(k);
    }
  }
}
while (Date.now() - t0 < seconds * 1000) {
  for (const p of [a, b]) {
    await p.page.bringToFront();
    await apply(p, plan(p, step));
  }
  if (step % 5 === 0) {
    for (const p of [a, b]) {
      corr[p.name].push(
        await p.page.evaluate(() => ({
          ...window.__game.graph.state,
          corrections: undefined,
          rttHistory: undefined,
        })),
      );
    }
  }
  step++;
  await sleep(250);
}
const shots = [];
for (const p of [a, b]) {
  const path = `${out}-${p.name}.png`;
  await p.page.screenshot({ path });
  shots.push(path);
}
const summary = {};
for (const p of [a, b]) {
  const g = await p.page.evaluate(() => {
    const s = window.__game.graph.state;
    const c = [...s.corrections].sort((x, y) => x - y);
    return {
      rtt: s.rtt,
      corrections: c.length,
      corrP50: c[Math.floor(c.length / 2)] ?? 0,
      corrP95: c[Math.floor(c.length * 0.95)] ?? 0,
      corrMax: c.at(-1) ?? 0,
      nonZero: c.filter((x) => x > 0.01).length,
      kbIn: s.bytesInPerSec / 1024,
      kbOut: s.bytesOutPerSec / 1024,
      bytesPerSnap: s.lastSnapshotBytes,
      pending: s.pending,
      underruns: s.underruns,
      snapsPerSec: s.snapshotsPerSec,
    };
  });
  summary[p.name] = g;
}
console.log(JSON.stringify({ extra, summary }, null, 1));
fs.writeFileSync(`${out}.json`, JSON.stringify({ extra, summary, samples: corr }, null, 1));
for (const p of [a, b]) await p.ctx.close();
await browser.close();
