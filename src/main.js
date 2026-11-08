import { AUTOPILOT, createRecorder, EXP, loopMode, maybeBlock } from "./experiments.js";
import { createInput, readControls } from "./input.js";
import { createLoop } from "./loop.js";
import { cameraFor, setupCanvas } from "./render/canvas.js";
import { drawBackground, drawHud, drawShip } from "./render/draw.js";
import { ARENA, wrapDelta } from "./sim/arena.js";
import { createShip, integrate, lerpAngle } from "./sim/ship.js";

const view = setupCanvas(document.getElementById("game"));
const input = createInput(window);
const recorder = createRecorder();

let previous = createShip();
let current = previous;
let simTime = 0;
let autopilotDone = false;

function autopilot() {
  if (autopilotDone) return { thrust: false, turn: 0, fire: false };
  if (simTime >= 5 - 1e-9) {
    autopilotDone = true;
    const result = { exp: EXP, steps: loop.stats.totalSteps, x: current.x, y: current.y };
    console.log("AUTOPILOT", JSON.stringify(result));
    window.__autopilot = result;
  }
  return { thrust: true, turn: 0.25, fire: false };
}

function simulate(dt) {
  const controls = AUTOPILOT ? autopilot() : readControls(input);
  previous = current;
  current = integrate(current, controls, dt);
  simTime += dt;
  input.endStep();
}

/** Interpolated view of the ship; handles edge wrap-around and angle wrap. */
function interpolate(a, b, t) {
  return {
    ...b,
    x: a.x + wrapDelta(a.x, b.x, ARENA.width) * t,
    y: a.y + wrapDelta(a.y, b.y, ARENA.height) * t,
    angle: lerpAngle(a.angle, b.angle, t),
  };
}

function render(alpha, stats) {
  recorder.mark(performance.now());
  maybeBlock();
  const { ctx } = view;
  const cam = cameraFor(view, ARENA);
  ctx.fillStyle = "#0b1d2e";
  ctx.fillRect(0, 0, view.width, view.height);
  ctx.save();
  ctx.translate(cam.ox, cam.oy);
  ctx.scale(cam.scale, cam.scale);
  ctx.beginPath();
  ctx.rect(0, 0, ARENA.width, ARENA.height);
  ctx.clip();
  drawBackground(ctx);
  const ship = interpolate(previous, current, alpha);
  // ghost copies across the edges make the wrap-around seamless
  for (const dx of [-ARENA.width, 0, ARENA.width]) {
    for (const dy of [-ARENA.height, 0, ARENA.height]) {
      drawShip(ctx, { ...ship, x: ship.x + dx, y: ship.y + dy }, { time: simTime });
    }
  }
  ctx.restore();
  const speed = Math.hypot(current.vx, current.vy).toFixed(0);
  drawHud(ctx, stats, [`mode     ${EXP}`, `speed    ${speed}`]);
}

const loop = createLoop({ step: 1 / 60, simulate, render, mode: loopMode() });
loop.start();

window.__game = {
  loop,
  recorder,
  get ship() {
    return current;
  },
};
