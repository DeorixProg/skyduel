// Runs the five Lab 3 ordering puzzles in real Chrome and prints the actual output.
// Usage: node tools/puzzles.mjs
import { chromium } from "playwright-core";

const puzzles = {
  "1-await": `
    const log = [];
    async function a() { log.push("a1"); await null; log.push("a2"); }
    log.push("start");
    a();
    Promise.resolve().then(() => log.push("then"));
    log.push("end");
    await new Promise((r) => setTimeout(r, 10));
    return log;`,
  "2-timeout-in-then": `
    const log = [];
    setTimeout(() => log.push("timeout A"), 0);
    Promise.resolve()
      .then(() => { log.push("then 1"); setTimeout(() => log.push("timeout B"), 0); })
      .then(() => log.push("then 2"));
    queueMicrotask(() => log.push("microtask"));
    log.push("sync");
    await new Promise((r) => setTimeout(r, 20));
    return log;`,
  "3-raf": `
    const log = [];
    requestAnimationFrame(() => {
      log.push("raf 1");
      Promise.resolve().then(() => log.push("raf 1 -> then"));
      setTimeout(() => log.push("raf 1 -> timeout"), 0);
    });
    requestAnimationFrame(() => log.push("raf 2"));
    setTimeout(() => log.push("timeout"), 0);
    Promise.resolve().then(() => log.push("then"));
    log.push("sync");
    await new Promise((r) => setTimeout(r, 100));
    return log;`,
  "4-async-return-promise": `
    const log = [];
    async function f() { return Promise.resolve("f"); }
    async function g() { return "g"; }
    f().then((v) => log.push(v));
    g().then((v) => log.push(v));
    Promise.resolve().then(() => log.push("p1")).then(() => log.push("p2")).then(() => log.push("p3"));
    await new Promise((r) => setTimeout(r, 10));
    return log;`,
  "5-event-dispatch": `
    const log = [];
    const bus = new EventTarget();
    bus.addEventListener("hit", () => {
      log.push("listener 1");
      Promise.resolve().then(() => log.push("listener 1 -> then"));
    });
    bus.addEventListener("hit", () => log.push("listener 2"));
    log.push("before dispatch");
    bus.dispatchEvent(new Event("hit"));
    log.push("after dispatch");
    await null;
    log.push("after await");
    return log;`,
};

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--mute-audio"],
  headless: false,
});
const page = await browser.newPage();
await page.goto("http://localhost:4173/");
for (const [name, body] of Object.entries(puzzles)) {
  const out = await page.evaluate(`(async () => { ${body} })()`);
  console.log(`${name}: ${out.join(", ")}`);
}
await browser.close();
