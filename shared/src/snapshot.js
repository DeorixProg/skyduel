/**
 * Snapshot = plain, serialisable view of the world that clients need.
 * Explosions are not sent: clients create them locally when they see a ship
 * go down or a balloon disappear (they are cosmetic and rng-heavy).
 */
export const KIND = Object.freeze({ ship: 1, bullet: 2, balloon: 3, pickup: 4 });
export const KIND_NAME = Object.freeze({ 1: "ship", 2: "bullet", 3: "balloon", 4: "pickup" });
export const EFFECTS = Object.freeze(["shield", "rapid", "homing"]);

export function takeSnapshot(world, tick) {
  const entities = [];
  for (const e of world) {
    if (!e.alive || e.kind === "explosion") continue;
    const base = {
      id: e.id,
      kind: e.kind,
      x: e.pos.x,
      y: e.pos.y,
      vx: e.vel.x,
      vy: e.vel.y,
      angle: e.angle,
    };
    if (e.kind === "ship") {
      base.hp = Math.max(0, e.hp);
      base.score = e.score;
      base.down = e.down;
      base.thrust = e.thrust;
      base.effects = EFFECTS.filter((fx) => e.effects.has(fx));
    } else if (e.kind === "bullet") {
      base.owner = e.ownerId;
      base.seq = e.seq;
      base.homing = Boolean(e.homing);
    } else if (e.kind === "balloon") {
      base.radius = Math.round(e.radius);
      base.hunter = Boolean(e.homing);
    } else if (e.kind === "pickup") {
      base.effect = e.pickup.effect;
    }
    entities.push(base);
  }
  return { tick, entities };
}

/** Cheap structural hash of a snapshot, for the determinism test (FNV-1a over a canonical string). */
export function hashSnapshot(snap) {
  const text = JSON.stringify(
    snap.entities.map((e) => [e.id, e.kind, e.x, e.y, e.vx, e.vy, e.angle]),
  );
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
