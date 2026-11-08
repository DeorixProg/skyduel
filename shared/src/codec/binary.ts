import { EFFECTS } from "../sim/entities.ts";
import type { Effect } from "../sim/entity.ts";
import {
  type ClientSnapshot,
  type EntityData,
  KIND_CODE,
  type Snapshot,
  type SnapshotKind,
} from "../snapshot.ts";
import { assertNever, entityId, type Input, type Seq, seq, tick } from "../types.ts";
import { type Codec, CodecError } from "./codec.ts";

/*
 * ─── Binary protocol, version 1 ─────────────────────────────────────────────
 * All multi-byte numbers are LITTLE-ENDIAN. Angles are Int16 in 1/10 000 rad
 * (±π → ±31 416, fits Int16; error ≤ 0.00005 rad — invisible on screen).
 *
 * INPUT (client → server), 3 + 6·n bytes, n = 1..8 (the last n inputs are
 * resent every time — redundancy that survives a dropped packet):
 *   u8  type = 1
 *   u8  version = 1
 *   u8  n
 *   n × { u32 seq | u8 buttons (bit0 thrust, bit1 fire) | i8 turn (−127..127) }
 *
 * SNAPSHOT (server → client), 12 bytes header + entities:
 *   u8  type = 2
 *   u8  version = 1
 *   u32 tick
 *   u32 ack            last input seq the server applied for THIS client
 *   u16 count
 *   count × entity:
 *     u16 id | u8 kind | u8 flags | f32 x | f32 y | f32 vx | f32 vy | i16 angle   (22 bytes)
 *     kind 1 ship:    u8 hp | u16 score                                          (+3)
 *     kind 2 bullet:  u16 owner | u32 seq                                        (+6)
 *     kind 3 balloon: u8 radius                                                  (+1)
 *     kind 4 pickup:  u8 effect (0 shield, 1 rapid, 2 homing)                    (+1)
 *   flags: bit0 ship.down | bullet.homing | balloon.hunter
 *          bit1 ship.thrust
 *          bit2..4 ship effects shield / rapid / homing
 * ────────────────────────────────────────────────────────────────────────────
 */
export const MSG = Object.freeze({ INPUT: 1, SNAPSHOT: 2 });
export const VERSION = 1;
export const ANGLE_SCALE = 10_000;
const HEADER = 12;
const BASE = 22;
const EXTRA = Object.freeze({ ship: 3, bullet: 6, balloon: 1, pickup: 1 } satisfies Record<
  SnapshotKind,
  number
>);
const KIND_BY_CODE: ReadonlyMap<number, SnapshotKind> = new Map(
  Object.entries(KIND_CODE).map(([name, code]) => [code, toKind(name)]),
);

function toKind(name: string): SnapshotKind {
  if (name === "ship" || name === "bullet" || name === "balloon" || name === "pickup") return name;
  throw new CodecError(`unknown kind ${name}`);
}

export { CodecError };
export const entitySize = (kind: SnapshotKind): number => BASE + EXTRA[kind];
export const snapshotSize = (entities: readonly EntityData[]): number =>
  HEADER + entities.reduce((n, e) => n + entitySize(e.kind), 0);
export const inputSize = (n: number): number => 3 + 6 * n;

export function encodeSnapshot(snap: Snapshot, ack: Seq): ArrayBuffer {
  const buf = new ArrayBuffer(snapshotSize(snap.entities));
  const v = new DataView(buf);
  v.setUint8(0, MSG.SNAPSHOT);
  v.setUint8(1, VERSION);
  v.setUint32(2, snap.tick, true);
  v.setUint32(6, ack, true);
  v.setUint16(10, snap.entities.length, true);
  let o = HEADER;
  for (const e of snap.entities) {
    let flags = 0;
    v.setUint16(o, e.id, true);
    v.setUint8(o + 2, KIND_CODE[e.kind]);
    v.setFloat32(o + 4, e.x, true);
    v.setFloat32(o + 8, e.y, true);
    v.setFloat32(o + 12, e.vx, true);
    v.setFloat32(o + 16, e.vy, true);
    v.setInt16(o + 20, Math.round(e.angle * ANGLE_SCALE), true);
    const x = o + BASE;
    switch (e.kind) {
      case "ship":
        if (e.down) flags |= 1;
        if (e.thrust) flags |= 2;
        for (const fx of e.effects) flags |= 4 << EFFECTS.indexOf(fx);
        v.setUint8(x, Math.max(0, Math.min(255, e.hp)));
        v.setUint16(x + 1, e.score, true);
        break;
      case "bullet":
        if (e.homing) flags |= 1;
        v.setUint16(x, e.owner, true);
        v.setUint32(x + 2, e.seq, true);
        break;
      case "balloon":
        if (e.hunter) flags |= 1;
        v.setUint8(x, e.radius);
        break;
      case "pickup":
        v.setUint8(x, EFFECTS.indexOf(e.effect));
        break;
      default:
        assertNever(e, "snapshot entity");
    }
    v.setUint8(o + 3, flags);
    o = x + EXTRA[e.kind];
  }
  return buf;
}

/** Decodes and VALIDATES: wrong type/version/length/kind → CodecError, never a crash. */
export function decodeSnapshot(data: unknown): ClientSnapshot {
  const v = toView(data);
  if (v.byteLength < HEADER) throw new CodecError(`snapshot too short: ${v.byteLength} B`);
  if (v.getUint8(0) !== MSG.SNAPSHOT) throw new CodecError(`not a snapshot: type ${v.getUint8(0)}`);
  if (v.getUint8(1) !== VERSION) throw new CodecError(`unsupported version ${v.getUint8(1)}`);
  const count = v.getUint16(10, true);
  const entities: EntityData[] = [];
  let o = HEADER;
  for (let i = 0; i < count; i++) {
    if (o + BASE > v.byteLength) throw new CodecError("truncated entity");
    const code = v.getUint8(o + 2);
    const kind = KIND_BY_CODE.get(code);
    if (!kind) throw new CodecError(`unknown kind ${code}`);
    if (o + BASE + EXTRA[kind] > v.byteLength) throw new CodecError("truncated entity extra");
    const flags = v.getUint8(o + 3);
    const base = {
      id: entityId(v.getUint16(o, true)),
      x: v.getFloat32(o + 4, true),
      y: v.getFloat32(o + 8, true),
      vx: v.getFloat32(o + 12, true),
      vy: v.getFloat32(o + 16, true),
      angle: v.getInt16(o + 20, true) / ANGLE_SCALE,
    };
    if (!Number.isFinite(base.x + base.y + base.vx + base.vy))
      throw new CodecError("non-finite number");
    if (Math.abs(base.angle) > Math.PI + 1e-3) throw new CodecError("angle out of range");
    const x = o + BASE;
    switch (kind) {
      case "ship":
        entities.push({
          ...base,
          kind,
          hp: v.getUint8(x),
          score: v.getUint16(x + 1, true),
          down: (flags & 1) !== 0,
          thrust: (flags & 2) !== 0,
          effects: EFFECTS.filter((_, k) => (flags & (4 << k)) !== 0),
        });
        break;
      case "bullet":
        entities.push({
          ...base,
          kind,
          owner: entityId(v.getUint16(x, true)),
          seq: seq(v.getUint32(x + 2, true)),
          homing: (flags & 1) !== 0,
        });
        break;
      case "balloon":
        entities.push({ ...base, kind, radius: v.getUint8(x), hunter: (flags & 1) !== 0 });
        break;
      case "pickup":
        entities.push({ ...base, kind, effect: effectAt(v.getUint8(x)) });
        break;
      default:
        assertNever(kind, "kind");
    }
    o = x + EXTRA[kind];
  }
  if (o !== v.byteLength) throw new CodecError(`length mismatch: parsed ${o} of ${v.byteLength} B`);
  return {
    type: "snapshot",
    tick: tick(v.getUint32(2, true)),
    ack: seq(v.getUint32(6, true)),
    entities,
  };
}

function effectAt(i: number): Effect {
  const fx = EFFECTS[i];
  if (fx === undefined) throw new CodecError(`unknown pickup effect ${i}`);
  return fx;
}

export function encodeInputs(inputs: readonly Input[]): ArrayBuffer {
  if (inputs.length < 1 || inputs.length > 8)
    throw new CodecError(`bad input count ${inputs.length}`);
  const buf = new ArrayBuffer(inputSize(inputs.length));
  const v = new DataView(buf);
  v.setUint8(0, MSG.INPUT);
  v.setUint8(1, VERSION);
  v.setUint8(2, inputs.length);
  let o = 3;
  for (const i of inputs) {
    v.setUint32(o, i.seq, true);
    v.setUint8(o + 4, (i.thrust ? 1 : 0) | (i.fire ? 2 : 0));
    v.setInt8(o + 5, Math.round(Math.max(-1, Math.min(1, i.turn)) * 127));
    o += 6;
  }
  return buf;
}

export function decodeInputs(data: unknown): readonly Input[] {
  const v = toView(data);
  if (v.byteLength < 3) throw new CodecError("input too short");
  if (v.getUint8(0) !== MSG.INPUT) throw new CodecError(`not an input: type ${v.getUint8(0)}`);
  if (v.getUint8(1) !== VERSION) throw new CodecError(`unsupported version ${v.getUint8(1)}`);
  const n = v.getUint8(2);
  if (n < 1 || n > 8) throw new CodecError(`bad input count ${n}`);
  if (v.byteLength !== inputSize(n))
    throw new CodecError(`input length ${v.byteLength} ≠ ${inputSize(n)}`);
  const inputs: Input[] = [];
  for (let k = 0, o = 3; k < n; k++, o += 6) {
    const buttons = v.getUint8(o + 4);
    const turn = v.getInt8(o + 5);
    if (buttons > 3) throw new CodecError("unknown button bits");
    if (turn < -127) throw new CodecError("turn out of range");
    inputs.push({
      seq: seq(v.getUint32(o, true)),
      thrust: (buttons & 1) !== 0,
      fire: (buttons & 2) !== 0,
      turn: turn / 127,
    });
  }
  return inputs;
}

/** Accept ArrayBuffer, any typed array, or a Node Buffer (which may be a slice of a pool). */
function toView(data: unknown): DataView {
  if (data instanceof ArrayBuffer) return new DataView(data);
  if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
  throw new CodecError("expected binary data");
}

export const binaryCodec: Codec = {
  name: "binary",
  encodeSnapshot,
  decodeSnapshot,
  encodeInputs,
  decodeInputs,
};
