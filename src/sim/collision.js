import { ARENA, wrapDelta } from "./arena.js";

/**
 * Collision DETECTION as a separate, swappable system: takes the world and
 * yields (a, b) pairs. Naive O(n²) for now; Lab 7 replaces it with a spatial
 * hash behind the same signature. Distances respect the wrapped arena.
 */
export function* naivePairs(world) {
  const list = [];
  for (const e of world) if (e.alive && e.collidable !== false) list.push(e);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (overlaps(list[i], list[j])) yield [list[i], list[j]];
    }
  }
}

export function overlaps(a, b) {
  const dx = wrapDelta(a.pos.x, b.pos.x, ARENA.width);
  const dy = wrapDelta(a.pos.y, b.pos.y, ARENA.height);
  const r = a.radius + b.radius;
  return dx * dx + dy * dy <= r * r;
}

/** Collision RESPONSE: each side reacts; pickups are handled by their component. */
export function resolveCollisions(world, pairs) {
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
function pickupSystem(world, a, b) {
  const item = a.pickup ? a : b;
  const ship = item === a ? b : a;
  if (ship.kind !== "ship" || ship.down) return;
  ship.effects.set(item.pickup.effect, item.pickup.duration);
  world.despawn(item.id);
  world.emit("pickup", { target: ship.id, effect: item.pickup.effect });
}
