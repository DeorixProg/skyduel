import { ARENA, wrapDelta } from "./arena.ts";
import type { AnyEntity } from "./entities.ts";
import type { Homing } from "./entity.ts";
import { Vector2 } from "./vector.ts";
import type { World } from "./world.ts";

/**
 * Homing as a SYSTEM over a COMPONENT. Works for anything that carries
 * `entity.homing` — a bullet fired under the "homing" pickup, or a hunter
 * balloon. No class needs to know.
 */
export function homingSystem(world: World, dt: number): void {
  for (const e of world) {
    if (!e.alive || !e.homing) continue;
    const homing = e.homing;
    const target = nearest(world, e, homing);
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
    const turn = Math.max(-homing.turnRate * dt, Math.min(homing.turnRate * dt, diff));
    e.vel = Vector2.fromAngle(current + turn, homing.speed);
  }
}

function nearest(world: World, e: AnyEntity, homing: Homing): AnyEntity | null {
  let best: AnyEntity | null = null;
  let bestD = homing.range * homing.range;
  const owner = e.kind === "bullet" ? e.ownerId : null;
  for (const t of world.ofKind(homing.targetKind)) {
    if (t === e || (t.kind === "ship" && t.down) || t.id === owner) continue;
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
