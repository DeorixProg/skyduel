import { ARENA, wrapDelta } from "./arena.js";
import { Vector2 } from "./vector.js";

/**
 * Homing as a SYSTEM over a COMPONENT. Works for anything that carries
 * `entity.homing = { targetKind, turnRate, range, speed }` — a bullet fired
 * under the "homing" pickup, or a hunter balloon. No class needs to know.
 */
export function homingSystem(world, dt) {
  for (const e of world) {
    if (!e.alive || !e.homing) continue;
    const target = nearest(world, e);
    if (!target) continue;
    const to = new Vector2(
      wrapDelta(e.pos.x, target.pos.x, ARENA.width),
      wrapDelta(e.pos.y, target.pos.y, ARENA.height),
    );
    const desired = to.angle();
    const current = e.vel.angle();
    let diff = desired - current;
    if (diff > Math.PI) diff -= Math.PI * 2;
    if (diff < -Math.PI) diff += Math.PI * 2;
    const turn = Math.max(-e.homing.turnRate * dt, Math.min(e.homing.turnRate * dt, diff));
    e.vel = Vector2.fromAngle(current + turn, e.homing.speed);
  }
}

function nearest(world, e) {
  let best = null;
  let bestD = e.homing.range * e.homing.range;
  for (const t of world.ofKind(e.homing.targetKind)) {
    if (t === e || t.down || t.id === e.ownerId) continue;
    const dx = wrapDelta(e.pos.x, t.pos.x, ARENA.width);
    const dy = wrapDelta(e.pos.y, t.pos.y, ARENA.height);
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}
