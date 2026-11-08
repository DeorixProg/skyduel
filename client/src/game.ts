import type { ArenaConfig } from "@skyduel/shared/arena-config.ts";
import { ARENA, wrapDelta } from "@skyduel/shared/sim/arena.ts";
import { type AnyEntity, Ship } from "@skyduel/shared/sim/entities.ts";
import { lerpAngle } from "@skyduel/shared/sim/ship.ts";
import { Vector2 } from "@skyduel/shared/sim/vector.ts";
import { World } from "@skyduel/shared/sim/world.ts";
import { assertNever, type Controls, type EntityId, seq } from "@skyduel/shared/types.ts";
import type { Audio } from "./audio.ts";
import {
  AUTOPILOT,
  createRecorder,
  EXP,
  loopMode,
  maybeBlock,
  type Recorder,
} from "./experiments.ts";
import { createHud } from "./hud.ts";
import { type Input, readControls } from "./input.ts";
import { createLoop, type Loop, type LoopStats } from "./loop.ts";
import { cameraFor, type View } from "./render/canvas.ts";
import { drawBackground, drawExplosion, drawHud, drawScoreboard } from "./render/draw.ts";
import { SHIP_COLORS, type Sprites } from "./render/sprites.ts";

export interface LocalGame {
  readonly loop: Loop;
  readonly recorder: Recorder;
  readonly world: World;
  readonly player: Ship;
  readonly drone: Ship;
  stop(): void;
}

/**
 * The local single-player match from Labs 1–3 (`?offline=1`): the same shared
 * simulation, run in the browser, against a training drone.
 */
export function startGame({
  view,
  input,
  sprites,
  audio,
  arena,
  name,
  params,
}: {
  view: View;
  input: Input;
  sprites: Sprites;
  audio: Audio | null;
  arena: ArenaConfig;
  name: string;
  params: URLSearchParams;
}): LocalGame {
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

  const nameOf = (id: EntityId) => {
    const e = world.get(id);
    return e?.kind === "ship" ? e.name : "?";
  };
  const hud = createHud(world.bus, { nameOf });
  const panOf = (id: EntityId) => {
    const e = world.get(id);
    return e ? (e.pos.x / ARENA.width) * 2 - 1 : 0;
  };
  const detachAudio = audio?.attach(world.bus, { panOf, localId: player.id });

  /** Training drone: flies wide circles and fires when the player is ahead. */
  function trainingDrone(ship: Ship, w: World): Controls {
    const target = w.get(player.id);
    let fire = false;
    if (target?.kind === "ship" && !target.down) {
      const dx = wrapDelta(ship.pos.x, target.pos.x, ARENA.width);
      const dy = wrapDelta(ship.pos.y, target.pos.y, ARENA.height);
      let off = Math.atan2(dy, dx) - ship.angle;
      off = Math.atan2(Math.sin(off), Math.cos(off));
      fire = Math.abs(off) < 0.15 && Math.hypot(dx, dy) < 500;
    }
    return { thrust: true, turn: 0.35, fire };
  }

  // Lab 2: the `this` bug, reproducible with ?bug=this. Since Lab 6 `Ship.fire`
  // declares `this: Ship`: a detached call `const f = player.fire; f()` is a
  // compile error (TS2684), but passing it as a DOM listener still compiles —
  // see README "What TypeScript found (and what it did not)".
  const BUG = params.get("bug");
  if (BUG === "this") window.addEventListener("keydown", player.fire);
  if (BUG === "arrow") window.addEventListener("keydown", () => player.fire());
  if (BUG === "bind") window.addEventListener("keydown", player.fire.bind(player));

  let simTime = 0;
  let contacts = 0;
  let tickSeq = 0;
  function simulate(dt: number): void {
    const controls: Controls = AUTOPILOT
      ? { thrust: true, turn: 0.25, fire: true }
      : readControls(input);
    world.step(dt, new Map([[player.id, { ...controls, seq: seq(++tickSeq) }]]));
    simTime += dt;
    contacts = world.lastCollisions;
    hud.update(dt);
    input.endStep();
  }

  // one scratch point reused for every entity, every frame: no Vector2 per draw (Lab 7)
  const scratch = { x: 0, y: 0 };
  function lerpPos(e: AnyEntity, alpha: number): { x: number; y: number } {
    const a = e.prevPos ?? e.pos;
    const dx = wrapDelta(a.x, e.pos.x, ARENA.width);
    const dy = wrapDelta(a.y, e.pos.y, ARENA.height);
    if (dx * dx + dy * dy > 200 * 200) {
      scratch.x = e.pos.x; // respawn teleport: don't smear
      scratch.y = e.pos.y;
    } else {
      scratch.x = a.x + dx * alpha;
      scratch.y = a.y + dy * alpha;
    }
    return scratch;
  }

  function render(alpha: number, stats: Readonly<LoopStats>): void {
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
      const angle = lerpAngle(e.prevAngle, e.angle, alpha);
      switch (e.kind) {
        case "balloon":
          sprites.balloon(ctx, { radius: e.radius, hunter: e.homing !== null }, pos);
          break;
        case "pickup":
          if (e.pickup) sprites.pickup(ctx, e.pickup.effect, pos, angle);
          break;
        case "bullet":
          sprites.bullet(ctx, e.homing !== null, pos, angle);
          break;
        case "explosion":
          drawExplosion(ctx, e);
          break;
        case "ship":
          if (e.down) break;
          sprites.ship(ctx, e, { x: pos.x, y: pos.y, angle, thrust: e.thrust }, simTime);
          drawShipOverlay(ctx, e, pos);
          break;
        default:
          assertNever(e, "entity kind");
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
    const rows = [];
    for (const s of world.ofKind("ship"))
      rows.push({ name: s.name, color: s.color, score: s.score, effects: s.effects.keys() });
    drawScoreboard(ctx, rows, view.width);
    hud.draw(ctx, view);
  }

  const loop = createLoop({ step: 1 / 60, simulate, render, mode: loopMode() });
  loop.start();
  return {
    loop,
    recorder,
    world,
    player,
    drone,
    stop() {
      loop.stop();
      detachAudio?.();
      hud.dispose();
    },
  };
}

function drawShipOverlay(
  ctx: CanvasRenderingContext2D,
  s: Ship,
  pos: { x: number; y: number },
): void {
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
