import type { EntityKind } from "./sim/entities.ts";
import { EFFECTS } from "./sim/entities.ts";
import type { Effect } from "./sim/entity.ts";
import { normalizeAngle } from "./sim/ship.ts";
import type { World } from "./sim/world.ts";
import { assertNever, type EntityId, type Seq, type Tick } from "./types.ts";

/**
 * Snapshot = the plain, serialisable, READONLY view of the world that clients
 * need. A discriminated union on `kind`: `if (e.kind === "bullet") e.owner`
 * type-checks, `e.owner` on a balloon does not. Explosions are not sent —
 * clients create them locally.
 */
interface EntityBase {
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
}
export interface ShipData extends EntityBase {
  readonly kind: "ship";
  readonly hp: number;
  readonly score: number;
  readonly down: boolean;
  readonly thrust: boolean;
  readonly effects: readonly Effect[];
}
export interface BulletData extends EntityBase {
  readonly kind: "bullet";
  readonly owner: EntityId;
  readonly seq: Seq;
  readonly homing: boolean;
}
export interface BalloonData extends EntityBase {
  readonly kind: "balloon";
  readonly radius: number;
  readonly hunter: boolean;
}
export interface PickupData extends EntityBase {
  readonly kind: "pickup";
  readonly effect: Effect;
}
export type EntityData = ShipData | BulletData | BalloonData | PickupData;
export type SnapshotKind = EntityData["kind"];

export interface Snapshot {
  readonly tick: Tick;
  readonly entities: readonly EntityData[];
}

/** Snapshot as received by one client: plus the last input seq the server applied for it. */
export interface ClientSnapshot extends Snapshot {
  readonly type: "snapshot";
  readonly ack: Seq;
}

export const KIND_CODE = Object.freeze({
  ship: 1,
  bullet: 2,
  balloon: 3,
  pickup: 4,
} satisfies Record<SnapshotKind, number>);

export function takeSnapshot(world: World, t: Tick): Snapshot {
  const entities: EntityData[] = [];
  for (const e of world) {
    if (!e.alive) continue;
    // normalise: a spinning pickup's angle grows without bound and would overflow Int16 on the wire
    const base = {
      id: e.id,
      x: e.pos.x,
      y: e.pos.y,
      vx: e.vel.x,
      vy: e.vel.y,
      angle: normalizeAngle(e.angle),
    };
    switch (e.kind) {
      case "ship":
        entities.push({
          ...base,
          kind: "ship",
          hp: Math.max(0, e.hp),
          score: e.score,
          down: e.down,
          thrust: e.thrust,
          effects: EFFECTS.filter((fx) => e.effects.has(fx)),
        });
        break;
      case "bullet":
        entities.push({
          ...base,
          kind: "bullet",
          owner: e.ownerId,
          seq: e.seq,
          homing: e.homing !== null,
        });
        break;
      case "balloon":
        entities.push({
          ...base,
          kind: "balloon",
          radius: Math.round(e.radius),
          hunter: e.homing !== null,
        });
        break;
      case "pickup":
        if (e.pickup) entities.push({ ...base, kind: "pickup", effect: e.pickup.effect });
        break;
      case "explosion":
        break; // cosmetic, recreated on the client
      default:
        assertNever(e, "entity kind");
    }
  }
  return { tick: t, entities };
}

/** Cheap structural hash of a snapshot, for the determinism test (FNV-1a over a canonical string). */
export function hashSnapshot(snap: Snapshot): string {
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

export type { EntityKind };
