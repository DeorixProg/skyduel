import { ARENA, wrapDelta } from "./arena.ts";
import type { AnyEntity, Ship } from "./entities.ts";
import type { World } from "./world.ts";

export type Pair = readonly [AnyEntity, AnyEntity];
/** A collision system: anything that turns a world into overlapping pairs. */
export type CollisionSystem = (world: World) => Iterable<Pair>;

/**
 * Collision DETECTION as a separate, swappable system: takes the world and
 * yields (a, b) pairs. Naive O(n²); Lab 7 adds a spatial hash behind the
 * same signature. Distances respect the wrapped arena.
 */
export function* naivePairs(world: World): Generator<Pair> {
  const list: AnyEntity[] = [];
  for (const e of world) if (e.alive && e.collidable) list.push(e);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (b && overlaps(a, b)) yield [a, b];
    }
  }
}

export function overlaps(a: AnyEntity, b: AnyEntity): boolean {
  const dx = wrapDelta(a.pos.x, b.pos.x, ARENA.width);
  const dy = wrapDelta(a.pos.y, b.pos.y, ARENA.height);
  const r = a.radius + b.radius;
  return dx * dx + dy * dy <= r * r;
}

/** Collision RESPONSE: each side reacts; pickups are handled by their component. */
export function resolveCollisions(world: World, pairs: Iterable<Pair>): number {
  let count = 0;
  for (const [a, b] of pairs) {
    if (!a.alive || !b.alive) continue; // killed earlier in this same pass
    count++;
    if (a.pickup || b.pickup) {
      pickupSystem(world, a, b);
      continue;
    }
    a.onHit(b);
    b.onHit(a);
  }
  return count;
}

/** Composition: any entity with a `pickup` component grants its effect to a ship. */
function pickupSystem(world: World, a: AnyEntity, b: AnyEntity): void {
  const item = a.pickup ? a : b;
  const other = item === a ? b : a;
  if (other.kind !== "ship" || !item.pickup) return;
  const ship: Ship = other;
  if (ship.down) return;
  ship.effects.set(item.pickup.effect, item.pickup.duration);
  world.despawn(item.id);
  world.emit("pickup", { target: ship.id, effect: item.pickup.effect });
}
