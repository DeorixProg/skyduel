// What a 300 ms synchronous handler does to everyone else: a WebSocket client
// pings every 20 ms while another client calls /api/slow three times.
// Server must run with ENABLE_SLOW_ENDPOINT=1 on :8080.
import { WebSocket } from "ws";

const ws = new WebSocket("ws://localhost:8080/ws");
await new Promise((r) => ws.once("open", r));
ws.send(JSON.stringify({ type: "join", room: "night", name: "Prober" }));
const rtts = [];
let phase = "baseline";
ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.type === "pong") rtts.push({ phase, rtt: performance.now() - m.t });
});
const timer = setInterval(
  () => ws.send(JSON.stringify({ type: "ping", t: performance.now() })),
  20,
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2000);
phase = "slow";
const slowTimes = [];
for (let i = 0; i < 3; i++) {
  const t = performance.now();
  await fetch("http://localhost:8080/api/slow");
  slowTimes.push(performance.now() - t);
  await sleep(700);
}
phase = "after";
await sleep(1000);
clearInterval(timer);
ws.close();
const stat = (p) => {
  const v = rtts
    .filter((r) => r.phase === p)
    .map((r) => r.rtt)
    .sort((a, b) => a - b);
  return { n: v.length, p50: v[Math.floor(v.length / 2)].toFixed(1), max: v.at(-1).toFixed(1) };
};
console.log(
  JSON.stringify({
    baseline: stat("baseline"),
    duringSlow: stat("slow"),
    after: stat("after"),
    slowHttpMs: slowTimes.map((x) => x.toFixed(0)),
  }),
);
