// Lab 8 chaos: the SERVER is killed mid-match (hard kill: no shutdown message, the socket
// just dies), then started again. The player must land in the lobby with a clear message
// and be able to play again. Usage: npm run build && node tools/chaos-server-kill.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright-core";

const PORT = 8095;
const BASE = `http://localhost:${PORT}`;
const OUT = "docs/lab08";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startServer = () =>
  spawn(process.execPath, ["server/src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: "warn" },
    stdio: "ignore",
  });
const waitHealthy = async () => {
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(`${BASE}/health`)
        .then((r) => r.ok)
        .catch(() => false)
    )
      return;
    await sleep(100);
  }
  throw new Error("server did not start");
};

let server = startServer();
await waitHealthy();
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--mute-audio"],
  headless: false,
});
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
await page.goto(BASE);
await page.click('#lobby .room[data-id="somme"]');
await page.click("#join");
await page.waitForFunction(() => window.__game?.latest);
await page.keyboard.down("KeyW");
await sleep(1500);
await page.screenshot({ path: `${OUT}/chaos-1-playing.png` });

const t0 = Date.now();
server.kill(); // TerminateProcess on Windows / SIGTERM elsewhere — on Windows: no graceful path at all
await page.waitForSelector("#lobby .panel", { timeout: 15000 });
const backInLobbyMs = Date.now() - t0;
await sleep(500);
const notice = await page.locator("#notice").textContent();
await page.screenshot({ path: `${OUT}/chaos-2-lobby-after-kill.png` });

const t1 = Date.now();
server = startServer();
await waitHealthy();
await page.waitForSelector("#lobby .room", { timeout: 15000 });
const roomsBackMs = Date.now() - t1;
await page.click('#lobby .room[data-id="somme"]');
await page.click("#join");
await page.waitForFunction(() => window.__game?.latest);
await page.screenshot({ path: `${OUT}/chaos-3-playing-again.png` });
await page.keyboard.up("KeyW");

const result = {
  backInLobbyMs,
  notice,
  roomsVisibleAfterRestartMs: roomsBackMs,
  playingAgain: true,
};
fs.writeFileSync(`${OUT}/chaos-server-kill.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
server.kill();
