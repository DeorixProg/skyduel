import { AUTOPILOT, createRecorder, EXP, loopMode, maybeBlock } from "./experiments.js";
import { createInput, readControls } from "./input.js";
import { createLoop } from "./loop.js";
import { cameraFor, setupCanvas } from "./render/canvas.js";
import {
  drawBackground,
  drawBalloon,
  drawBullet,
  drawExplosion,
  drawHud,
  drawPickup,
  drawScoreboard,
  drawShipEntity,
} from "./render/draw.js";
import { ARENA, wrapDelta } from "./sim/arena.js";
import { Ship } from "./sim/entities.js";
import { lerpAngle } from "./sim/ship.js";
import { Vector2 } from "./sim/vector.js";
import { World } from "./sim/world.js";

const params = new URLSearchParams(location.search);
const view = setupCanvas(document.getElementById("game"));
const input = createInput(window);
const recorder = createRecorder();

const world = new World({ seed: Number(params.get("seed") ?? 22) });
const player = world.spawn(
  new Ship({ pos: new Vector2(400, 450), angle: 0, name: "Maksym", color: "#c0392b" }),
);
const drone = world.spawn(
  new Ship({ pos: new Vector2(1200, 450), angle: Math.PI, name: "Drone", color: "#2c3e50" }),
);
drone.controller = trainingDrone;
world.populate();

/**
 * Training drone: flies wide circles and fires when the player is ahead.
 * A plain function of (ship, world) — reads state, returns controls.
 */
function trainingDrone(ship, w) {
  const target = w.get(player.id);
  let fire = false;
  if (target && !target.down) {
    const dx = wrapDelta(ship.pos.x, target.pos.x, ARENA.width);
    const dy = wrapDelta(ship.pos.y, target.pos.y, ARENA.height);
    let off = Math.atan2(dy, dx) - ship.angle;
    off = Math.atan2(Math.sin(off), Math.cos(off));
    fire = Math.abs(off) < 0.15 && Math.hypot(dx, dy) < 500;
  }
  return { thrust: true, turn: 0.35, fire };
}

// ── Lab 2: the `this` bug, reproducible with ?bug=this ─────────────────────────
// Passing a method as a bare function loses its receiver. For a DOM listener,
// `this` becomes the event target (window), and the private-field access in
// fire() throws: "Cannot read private member #cooldown from an object whose
// class did not declare it". Fixes are discussed in the README.
const BUG = params.get("bug");
if (BUG === "this") window.addEventListener("keydown", player.fire);
if (BUG === "arrow") window.addEventListener("keydown", () => player.fire());
if (BUG === "bind") window.addEventListener("keydown", player.fire.bind(player));

let simTime = 0;
function simulate(dt) {
  const controls = AUTOPILOT ? { thrust: true, turn: 0.25, fire: true } : readControls(input);
  world.step(dt, new Map([[player.id, controls]]));
  simTime += dt;
  input.endStep();
  hud.collisions = world.lastCollisions;
  for (const ev of world.events) if (ev.type === "exploded") hud.kills.push(ev);
  world.events.length = 0;
}

const hud = { collisions: 0, kills: [] };

function lerpPos(e, alpha) {
  const a = e.prevPos ?? e.pos;
  const dx = wrapDelta(a.x, e.pos.x, ARENA.width);
  const dy = wrapDelta(a.y, e.pos.y, ARENA.height);
  if (dx * dx + dy * dy > 200 * 200) return e.pos; // respawn teleport: don't smear
  return new Vector2(a.x + dx * alpha, a.y + dy * alpha);
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

  for (const e of world) {
    const pos = lerpPos(e, alpha);
    const angle = lerpAngle(e.prevAngle ?? e.angle, e.angle, alpha);
    if (e.kind === "balloon") drawBalloon(ctx, e, pos, angle);
    else if (e.kind === "pickup") drawPickup(ctx, e, pos, angle);
    else if (e.kind === "bullet") drawBullet(ctx, e, pos, angle);
    else if (e.kind === "explosion") drawExplosion(ctx, e);
    else if (e.kind === "ship") drawShipEntity(ctx, e, simTime, pos, angle);
  }
  ctx.restore();

  drawHud(ctx, stats, [
    `entities ${world.size}`,
    `contacts ${hud.collisions}`,
    `hp       ${player.hp}${player.down ? ` (respawn ${player.respawnIn.toFixed(1)})` : ""}`,
    `mode     ${EXP}`,
  ]);
  drawScoreboard(ctx, world.ofKind("ship"), view.width);
}

const loop = createLoop({ step: 1 / 60, simulate, render, mode: loopMode() });
loop.start();

window.__game = { loop, recorder, world, player, drone };
