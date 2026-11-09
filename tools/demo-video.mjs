// Demo video for the README (Lab 8): records real play with Playwright (muted) and glues the
// parts with ffmpeg. Captions are a DOM overlay injected into the page, so they are part of
// the recording. Usage: npm run build && node tools/demo-video.mjs  → docs/lab08/demo.mp4
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const PORT = 8094;
const BASE = `http://localhost:${PORT}`;
const OUT = path.resolve("docs/lab08");
const TMP = path.resolve("test-results/demo");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIZE = { width: 1280, height: 720 };

const startServer = () =>
  spawn(process.execPath, ["server/src/index.ts"], { env: { ...process.env, PORT: String(PORT), LOG_LEVEL: "warn", MAX_PLAYERS_PER_ROOM: "16" }, stdio: "ignore" });
const healthy = async () => {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false)) return;
    await sleep(100);
  }
  throw new Error("server did not start");
};

async function caption(page, text) {
  await page.evaluate((t) => {
    let el = document.getElementById("__cap");
    if (!el) {
      el = document.createElement("div");
      el.id = "__cap";
      el.style.cssText =
        "position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:99999;max-width:900px;padding:10px 18px;border-radius:10px;background:rgba(10,20,35,.85);color:#fff;font:600 20px system-ui;text-align:center;pointer-events:none;box-shadow:0 6px 24px rgba(0,0,0,.35)";
      document.body.append(el);
    }
    el.textContent = t;
  }, text);
}

const keys = new Set();
async function hold(page, want) {
  for (const k of ["KeyW", "KeyA", "KeyD", "Space"]) {
    if (want.includes(k) && !keys.has(k)) {
      await page.keyboard.down(k);
      keys.add(k);
    } else if (!want.includes(k) && keys.has(k)) {
      await page.keyboard.up(k);
      keys.delete(k);
    }
  }
}
async function fly(page, seconds) {
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < seconds * 1000) {
    const p = i++ % 8;
    await hold(page, p < 3 ? ["KeyW", "Space"] : p < 5 ? ["KeyW", "KeyA", "Space"] : p < 6 ? ["KeyW"] : ["KeyW", "KeyD", "Space"]);
    await sleep(500);
  }
  await hold(page, []);
}

let server = startServer();
await healthy();
const browser = await chromium.launch({ channel: "chrome", args: ["--mute-audio"], headless: false });

// ── part A: one player, full tour ─────────────────────────────────────────────
const ctxA = await browser.newContext({ viewport: SIZE, recordVideo: { dir: `${TMP}/a`, size: SIZE } });
const page = await ctxA.newPage();
await page.goto(BASE);
await page.waitForSelector("#lobby .room");
await caption(page, "SkyDuel — дуель біпланів у браузері. Лобі отримує кімнати з сервера (GET /api/rooms)");
await sleep(4000);
await page.fill("#newroom", "Demo");
await page.click("#create button");
await sleep(800);
await fetch(`${BASE}/api/rooms/night/bots`, { method: "POST", body: JSON.stringify({ count: 3 }) });
await caption(page, "Кімнату можна створити (POST /api/rooms). У «Нічний патруль» додаємо 3 серверних ботів");
await sleep(3500);
await page.fill("#pilot", "Maksym");
await page.click('#lobby .room[data-id="night"]');
await page.click("#join");
await page.waitForFunction(() => window.__game?.latest);
await caption(page, "Бій: W — газ, A/D — поворот, Space — постріл. Сервер рахує світ 30 разів/с");
await fly(page, 45);
await caption(page, "Netgraph: RTT, вік знімка, байти/с, непідтверджені input, поправки звірки (зелені = 0)");
await fly(page, 20);
await caption(page, "Аеростати лопаються від 3 куль і лишають бонуси: S — щит, R — скорострільність, H — самонаведення");
await fly(page, 25);
await page.keyboard.press("Enter");
await page.keyboard.type("Привіт з демо-відео!");
await page.keyboard.press("Enter");
await caption(page, "Чат кімнати (Enter) — через той самий WebSocket, перевірка Zod на сервері");
await sleep(4000);

// latency injector: reconnect through ?lag=150 and show prediction keeps the ship responsive
await page.goto(`${BASE}/?lag=150&jitter=30&drop=0.02`);
await page.waitForSelector('#lobby .room[data-id="night"]');
await page.click('#lobby .room[data-id="night"]');
await page.click("#join");
await page.waitForFunction(() => window.__game?.latest);
await caption(page, "Інжектор мережі: +150 мс, ±15 мс, 2 % втрат. Свій літак відгукується миттєво — передбачення");
await fly(page, 15);
await page.goto(`${BASE}/?lag=150&jitter=30&drop=0.02&predict=0`);
await page.waitForSelector('#lobby .room[data-id="night"]');
await page.click('#lobby .room[data-id="night"]');
await page.click("#join");
await page.waitForFunction(() => window.__game?.latest);
await caption(page, "Те саме БЕЗ передбачення (?predict=0): літак рухається лише після знімка — запізнення ≈ 200 мс");
await fly(page, 12);

// production endpoints
await page.goto(`${BASE}/metrics`);
await caption(page, "/metrics (Prometheus): гравці, кімнати, повідомлення/с, байти/с, крок p99, зайнятість циклу подій, RSS");
await page.mouse.wheel(0, 2200);
await sleep(7000);
await page.goto(`${BASE}/health`);
await caption(page, "/health — живий процес і git SHA збірки; /ready — чи можна пускати нових гравців");
await sleep(5000);

// chaos: kill the server mid-match
await page.goto(BASE);
await page.waitForSelector('#lobby .room[data-id="somme"]');
await page.click('#lobby .room[data-id="somme"]');
await page.click("#join");
await page.waitForFunction(() => window.__game?.latest);
await caption(page, "Хаос-тест: зараз сервер буде вбито посеред матчу…");
await fly(page, 5);
server.kill();
await page.waitForSelector("#lobby .panel", { timeout: 15000 });
await caption(page, "…гра не зависає: гравець у лобі з чітким повідомленням, лобі чекає на сервер");
await sleep(5000);
server = startServer();
await healthy();
await page.waitForSelector('#lobby .room[data-id="somme"]', { timeout: 15000 });
await caption(page, "Сервер повернувся — кімнати знову видно, Join — і гра продовжується");
await sleep(2500);
await page.click('#lobby .room[data-id="somme"]');
await page.click("#join");
await page.waitForFunction(() => window.__game?.latest);
await fly(page, 6);
await ctxA.close();

// ── part B: two windows, one room ─────────────────────────────────────────────
const half = { width: 640, height: 720 };
async function pilot(name, dir) {
  const ctx = await browser.newContext({ viewport: half, recordVideo: { dir, size: half } });
  const p = await ctx.newPage();
  await p.goto(BASE);
  await p.waitForSelector('#lobby .room[data-id="verdun"]');
  await p.fill("#pilot", name);
  await p.click('#lobby .room[data-id="verdun"]');
  await p.click("#join");
  await p.waitForFunction(() => window.__game?.latest);
  return { ctx, p };
}
const a = await pilot("Maksym", `${TMP}/b1`);
const b = await pilot("Sofiia", `${TMP}/b2`);
await caption(a.p, "Два вікна — одна кімната: кожен бачить іншого");
await caption(b.p, "сервер авторитетний, чужі літаки інтерпольовані");
const t0 = Date.now();
let i = 0;
while (Date.now() - t0 < 45_000) {
  const phase = i++ % 10;
  for (const [w, shift] of [[a.p, 0], [b.p, 5]]) {
    const q = (phase + shift) % 10;
    await w.bringToFront();
    await w.keyboard[q < 7 ? "down" : "up"]("KeyW");
    await w.keyboard[q % 3 === 0 ? "down" : "up"]("Space");
    await w.keyboard[q >= 4 && q < 6 ? "down" : "up"]("KeyA");
  }
  await sleep(300);
}
await a.ctx.close();
await b.ctx.close();
await browser.close();
server.kill();

// ── glue with ffmpeg ──────────────────────────────────────────────────────────
const webm = (dir) => path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".webm")));
const ff = (args) => {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
};
ff(["-i", webm(`${TMP}/a`), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "26", "-preset", "veryfast", `${TMP}/a.mp4`]);
ff(["-i", webm(`${TMP}/b1`), "-i", webm(`${TMP}/b2`), "-filter_complex", "[0:v]trim=start=2,setpts=PTS-STARTPTS[l];[1:v]trim=start=1,setpts=PTS-STARTPTS[r];[l][r]hstack=inputs=2,fps=30,format=yuv420p,trim=duration=45", "-c:v", "libx264", "-crf", "26", "-preset", "veryfast", `${TMP}/b.mp4`]);
fs.writeFileSync(`${TMP}/list.txt`, `file '${TMP.replaceAll("\\", "/")}/a.mp4'\nfile '${TMP.replaceAll("\\", "/")}/b.mp4'\n`);
ff(["-f", "concat", "-safe", "0", "-i", `${TMP}/list.txt`, "-c", "copy", "-movflags", "+faststart", `${OUT}/demo.mp4`]);
const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${OUT}/demo.mp4`], { encoding: "utf8" });
console.log("demo.mp4", (fs.statSync(`${OUT}/demo.mp4`).size / 1048576).toFixed(1), "MB,", Number(probe.stdout).toFixed(0), "s");
