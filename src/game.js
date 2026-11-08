import { AUTOPILOT, createRecorder, EXP, loopMode, maybeBlock } from "./experiments.js";
import { createHud } from "./hud.js";
import { readControls } from "./input.js";
import { createLoop } from "./loop.js";
import { cameraFor } from "./render/canvas.js";
import { drawBackground, drawExplosion, drawHud, drawScoreboard } from "./render/draw.js";
import { SHIP_COLORS } from "./render/sprites.js";
import { ARENA, wrapDelta } from "./sim/arena.js";
import { Ship } from "./sim/entities.js";
import { lerpAngle } from "./sim/ship.js";
import { Vector2 } from "./sim/vector.js";
import { World } from "./sim/world.js";

/**
 * A local match on the given arena. Everything the game needs is passed in
 * (canvas view, input, loaded sprites, audio), so main.js can show the
 * loading screen and the lobby first and only then call startGame().
 */
export function startGame({ view, input, sprites, audio, arena, name, params }) {
  const recorder = createRecorder();
  const world = new World({ seed: arena.seed });
  const player = world.spawn(
    new Ship({ pos: new Vector2(400, 450), angle: 0, name, color: SHIP_COLORS[0] }),
  );
  const drone = world.spawn(
    new Ship({ pos: new Vector2(1200, 450), angle: Math.PI, name: "Drone", color: SHIP_COLORS[1] }),
  );
  drone.controller = trainingDrone;
  world.populate({ balloons: arena.balloons, hunters: arena.hunters });

  const nameOf = (id) => world.get(id)?.name ?? "?";
  const hud = createHud(world.bus, { nameOf });
  const panOf = (id) => {
    const e = world.get(id);
    return e ? (e.pos.x / ARENA.width) * 2 - 1 : 0;
  };
  audio?.attach(world.bus, { panOf, localId: player.id });

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

  // Lab 2: the `this` bug, reproducible with ?bug=this (see README)
  const BUG = params.get("bug");
  if (BUG === "this") window.addEventListener("keydown", player.fire);
  if (BUG === "arrow") window.addEventListener("keydown", () => player.fire());
  if (BUG === "bind") window.addEventListener("keydown", player.fire.bind(player));

  let simTime = 0;
  let contacts = 0;
  function simulate(dt) {
    const controls = AUTOPILOT ? { thrust: true, turn: 0.25, fire: true } : readControls(input);
    world.step(dt, new Map([[player.id, controls]]));
    simTime += dt;
    contacts = world.lastCollisions;
    hud.update(dt);
    input.endStep();
  }

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
    drawBackground(ctx, arena.sky);

    for (const e of world) {
      const pos = lerpPos(e, alpha);
      const angle = lerpAngle(e.prevAngle ?? e.angle, e.angle, alpha);
      if (e.kind === "balloon") sprites.balloon(ctx, e, pos);
      else if (e.kind === "pickup") sprites.pickup(ctx, e, pos, angle);
      else if (e.kind === "bullet") sprites.bullet(ctx, e, pos, angle);
      else if (e.kind === "explosion") drawExplosion(ctx, e);
      else if (e.kind === "ship" && !e.down) {
        sprites.ship(ctx, e, pos, angle, simTime);
        drawShipOverlay(ctx, e, pos);
      }
    }
    ctx.restore();

    drawHud(ctx, stats, [
      `entities ${world.size}`,
      `contacts ${contacts}`,
      `hp       ${player.hp}${player.down ? ` (respawn ${player.respawnIn.toFixed(1)})` : ""}`,
      `arena    ${arena.name}`,
      `sprites  ${sprites.usingSheet ? "sheet" : "vector fallback"}`,
      `mode     ${EXP}`,
    ]);
    drawScoreboard(ctx, world.ofKind("ship"), view.width);
    hud.draw(ctx, view);
  }

  const loop = createLoop({ step: 1 / 60, simulate, render, mode: loopMode() });
  loop.start();
  return { loop, recorder, world, player, drone };
}

function drawShipOverlay(ctx, s, pos) {
  if (s.effects.has("shield")) {
    ctx.strokeStyle = "rgba(41,128,185,0.8)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, s.radius + 8, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(pos.x - 20, pos.y - 34, 40, 5);
  ctx.fillStyle = s.hp > 50 ? "#27ae60" : s.hp > 25 ? "#f39c12" : "#c0392b";
  ctx.fillRect(pos.x - 20, pos.y - 34, 40 * (s.hp / 100), 5);
  ctx.fillStyle = "#1b2631";
  ctx.font = "12px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(s.name, pos.x, pos.y - 39);
  ctx.textAlign = "start";
}
