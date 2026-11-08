// Lab 3 evidence: failure gallery screenshots, sequential vs concurrent timing, lobby abort.
// Usage: npm run build && npx vite preview --port 4173, then: node tools/measure-lab3.mjs
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = "http://localhost:4173/";
const OUT = "docs/lab03";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 650 } });
const report = {};

async function run(name, query, act) {
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`PAGEERROR: ${e.message}`));
  await page.goto(BASE + query);
  let result;
  try {
    result = await act(page);
  } catch (err) {
    await page.screenshot({ path: `${OUT}/ERROR-${name}.png` });
    result = { error: err.message.split(String.fromCharCode(10))[0] };
  }
  report[name] = { ...result, logs };
  console.log(name, JSON.stringify(report[name]));
  await page.close();
}

const lobbyVisible = (p) => p.locator("#lobby .panel").isVisible();

// 1. Failure gallery
await run("404", "?fail=404", async (p) => {
  await p.waitForSelector("#lobby .room", { timeout: 30000 });
  await p.screenshot({ path: `${OUT}/fail-404-lobby.png` });
  await p.click("#lobby .room >> nth=0");
  await p.click("#join");
  await sleep(1500);
  await p.screenshot({ path: `${OUT}/fail-404-game.png` });
  return { started: !(await lobbyVisible(p)) };
});
await run("503", "?fail=503", async (p) => {
  await p.waitForSelector("#lobby .room", { timeout: 30000 });
  return { lobby: await lobbyVisible(p) };
});
await run("timeout", "?fail=timeout", async (p) => {
  const t0 = Date.now();
  await p.waitForSelector("#retry:not([hidden])", { timeout: 20000 });
  const tFail = Date.now() - t0;
  await sleep(300);
  await p.screenshot({ path: `${OUT}/fail-timeout.png` });
  await p.click("#retry");
  await p.waitForSelector("#lobby .room", { timeout: 30000 });
  return { msUntilRetryButton: tFail, recoveredAfterRetry: true };
});
await run("abort", "?fail=abort&netlag=400", async (p) => {
  await p.waitForSelector("#retry:not([hidden])", { timeout: 10000 });
  await sleep(300);
  await p.screenshot({ path: `${OUT}/fail-abort.png` });
  await p.click("#retry");
  await p.waitForSelector("#lobby .room", { timeout: 30000 });
  return { recoveredAfterRetry: true };
});
await run("badjson", "?fail=badjson", async (p) => {
  await p.waitForSelector("#lobby .room", { timeout: 30000 });
  await p.click("#lobby .room >> nth=1");
  await p.click("#join");
  await sleep(1500);
  await p.screenshot({ path: `${OUT}/fail-badjson-game.png` });
  return { started: !(await lobbyVisible(p)) };
});
await run("rooms", "?fail=rooms", async (p) => {
  await p.waitForSelector("#lobby .error", { timeout: 10000 });
  await p.screenshot({ path: `${OUT}/fail-rooms.png` });
  return { status: await p.locator("#status").innerText() };
});

// 2. Sequential vs concurrent, 150 ms simulated latency per response, 5 runs each
for (const mode of ["seq", "concurrent"]) {
  const times = [];
  for (let i = 0; i < 5; i++) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}?netlag=150${mode === "seq" ? "&load=seq" : ""}`);
    await page.waitForFunction(() => window.__load, null, { timeout: 20000 });
    times.push(await page.evaluate(() => window.__load.ms));
    await page.close();
  }
  report[`timing_${mode}`] = times;
}
for (const mode of ["seq", "concurrent"]) {
  const times = [];
  for (let i = 0; i < 5; i++) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}${mode === "seq" ? "?load=seq" : ""}`);
    await page.waitForFunction(() => window.__load, null, { timeout: 20000 });
    times.push(await page.evaluate(() => window.__load.ms));
    await page.close();
  }
  report[`timing_local_${mode}`] = times;
}

// 3. Lobby: polling while visible, abort on leave, loading screen mid-progress, gameplay
await run("lobby", "?netlag=300&roomslag=1500", async (p) => {
  await sleep(250);
  await p.screenshot({ path: `${OUT}/loading.png` });
  await p.waitForSelector("#lobby .room", { timeout: 30000 });
  await p.screenshot({ path: `${OUT}/lobby.png` });
  await sleep(4800); // polls start at ~0.4, 3.4, 6.4 s and take 1.5 s: the third is in flight when we leave
  const before = await p.evaluate(() => ({ requests: window.__lobby.requests }));
  await p.click("#lobby .room >> nth=0");
  await p.click("#join");
  await sleep(6000);
  const after = await p.evaluate(() => ({
    requests: window.__lobby.requests,
    aborted: window.__lobby.aborted,
    active: window.__lobby.active,
  }));
  await p.keyboard.down("KeyW");
  await p.keyboard.down("Space");
  await sleep(1500);
  await p.screenshot({ path: `${OUT}/game.png` });
  await p.keyboard.up("Space");
  const audio = await p.evaluate(() => document.querySelector("canvas") && "ok");
  return { before, after, audio };
});

fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
