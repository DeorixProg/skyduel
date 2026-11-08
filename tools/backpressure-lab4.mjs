// Downloads a big replay through a throttled reader and samples the server's RSS.
// Usage: node tools/backpressure-lab4.mjs <mode: stream|buffer> <MB/s> [seconds]
import fs from "node:fs";
import http from "node:http";

const mode = process.argv[2] ?? "stream";
const rate = Number(process.argv[3] ?? 4) * 1024 * 1024;
const maxSeconds = Number(process.argv[4] ?? 40);
const BASE = "http://localhost:8080";
const samples = [];
const t0 = performance.now();

const sample = async () => {
  const h = await (await fetch(`${BASE}/health`)).json();
  samples.push({
    t: (performance.now() - t0) / 1000,
    rssMB: h.rss / 1048576,
    gotMB: got / 1048576,
  });
};
let got = 0;
await sample();
const timer = setInterval(sample, 250);

await new Promise((resolve, reject) => {
  const q = mode === "buffer" ? "?mode=buffer" : "";
  http.get(`${BASE}/api/replays/big-synthetic${q}`, (res) => {
    const start = performance.now();
    res.on("data", (chunk) => {
      got += chunk.length;
      // throttle: if we are ahead of the budget, stop reading for a while.
      // A paused stream stops draining the socket → TCP window fills → the
      // server's res.write() returns false → pipeline() stops reading the file.
      const ahead = got / rate - (performance.now() - start) / 1000;
      if (ahead > 0) {
        res.pause();
        setTimeout(() => res.resume(), ahead * 1000);
      }
      if ((performance.now() - t0) / 1000 > maxSeconds) {
        res.destroy();
        resolve();
      }
    });
    res.on("end", resolve);
    res.on("error", reject);
  });
});
await new Promise((r) => setTimeout(r, 1500)); // a few samples after the end
clearInterval(timer);
await sample();
fs.mkdirSync("docs/lab04", { recursive: true });
fs.writeFileSync(`docs/lab04/rss-${mode}.json`, JSON.stringify(samples));
const peak = Math.max(...samples.map((s) => s.rssMB));
console.log(
  `${mode}: downloaded ${(got / 1048576).toFixed(0)} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s, RSS start ${samples[0].rssMB.toFixed(1)} MB, peak ${peak.toFixed(1)} MB`,
);
