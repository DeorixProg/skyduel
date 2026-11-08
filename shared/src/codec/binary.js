import { EFFECTS, KIND, KIND_NAME } from "../snapshot.js";

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
const EXTRA = { [KIND.ship]: 3, [KIND.bullet]: 6, [KIND.balloon]: 1, [KIND.pickup]: 1 };

export class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodecError";
  }
}

export const entitySize = (kind) => BASE + EXTRA[KIND[kind]];
export const snapshotSize = (entities) =>
  HEADER + entities.reduce((n, e) => n + entitySize(e.kind), 0);
export const inputSize = (n) => 3 + 6 * n;

export function encodeSnapshot(snap, ack) {
  const buf = new ArrayBuffer(snapshotSize(snap.entities));
  const v = new DataView(buf);
  v.setUint8(0, MSG.SNAPSHOT);
  v.setUint8(1, VERSION);
  v.setUint32(2, snap.tick, true);
  v.setUint32(6, ack, true);
  v.setUint16(10, snap.entities.length, true);
  let o = HEADER;
  for (const e of snap.entities) {
    const kind = KIND[e.kind];
    let flags = 0;
    if (e.down || e.homing || e.hunter) flags |= 1;
    if (e.thrust) flags |= 2;
    for (const fx of e.effects ?? []) flags |= 4 << EFFECTS.indexOf(fx);
    v.setUint16(o, e.id, true);
    v.setUint8(o + 2, kind);
    v.setUint8(o + 3, flags);
    v.setFloat32(o + 4, e.x, true);
    v.setFloat32(o + 8, e.y, true);
    v.setFloat32(o + 12, e.vx, true);
    v.setFloat32(o + 16, e.vy, true);
    v.setInt16(o + 20, Math.round(e.angle * ANGLE_SCALE), true);
    o += BASE;
    if (kind === KIND.ship) {
      v.setUint8(o, Math.max(0, Math.min(255, e.hp)));
      v.setUint16(o + 1, e.score, true);
    } else if (kind === KIND.bullet) {
      v.setUint16(o, e.owner, true);
      v.setUint32(o + 2, e.seq, true);
    } else if (kind === KIND.balloon) {
      v.setUint8(o, e.radius);
    } else {
      v.setUint8(o, EFFECTS.indexOf(e.effect));
    }
    o += EXTRA[kind];
  }
  return buf;
}

/** Decodes and VALIDATES: wrong type/version/length/kind → CodecError, never a crash. */
export function decodeSnapshot(buf) {
  const v = toView(buf);
  if (v.byteLength < HEADER) throw new CodecError(`snapshot too short: ${v.byteLength} B`);
  if (v.getUint8(0) !== MSG.SNAPSHOT) throw new CodecError(`not a snapshot: type ${v.getUint8(0)}`);
  if (v.getUint8(1) !== VERSION) throw new CodecError(`unsupported version ${v.getUint8(1)}`);
  const tick = v.getUint32(2, true);
  const ack = v.getUint32(6, true);
  const count = v.getUint16(10, true);
  const entities = new Array(count);
  let o = HEADER;
  for (let i = 0; i < count; i++) {
    if (o + BASE > v.byteLength) throw new CodecError("truncated entity");
    const kindNum = v.getUint8(o + 2);
    const kind = KIND_NAME[kindNum];
    if (!kind) throw new CodecError(`unknown kind ${kindNum}`);
    if (o + BASE + EXTRA[kindNum] > v.byteLength) throw new CodecError("truncated entity extra");
    const flags = v.getUint8(o + 3);
    const e = {
      id: v.getUint16(o, true),
      kind,
      x: v.getFloat32(o + 4, true),
      y: v.getFloat32(o + 8, true),
      vx: v.getFloat32(o + 12, true),
      vy: v.getFloat32(o + 16, true),
      angle: v.getInt16(o + 20, true) / ANGLE_SCALE,
    };
    if (!Number.isFinite(e.x + e.y + e.vx + e.vy)) throw new CodecError("non-finite number");
    o += BASE;
    if (kindNum === KIND.ship) {
      e.hp = v.getUint8(o);
      e.score = v.getUint16(o + 1, true);
      e.down = Boolean(flags & 1);
      e.thrust = Boolean(flags & 2);
      e.effects = EFFECTS.filter((_, k) => flags & (4 << k));
    } else if (kindNum === KIND.bullet) {
      e.owner = v.getUint16(o, true);
      e.seq = v.getUint32(o + 2, true);
      e.homing = Boolean(flags & 1);
    } else if (kindNum === KIND.balloon) {
      e.radius = v.getUint8(o);
      e.hunter = Boolean(flags & 1);
    } else {
      const fx = EFFECTS[v.getUint8(o)];
      if (!fx) throw new CodecError("unknown pickup effect");
      e.effect = fx;
    }
    o += EXTRA[kindNum];
    entities[i] = e;
  }
  if (o !== v.byteLength) throw new CodecError(`length mismatch: parsed ${o} of ${v.byteLength} B`);
  return { type: "snapshot", tick, ack, entities };
}

export function encodeInputs(inputs) {
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

export function decodeInputs(buf) {
  const v = toView(buf);
  if (v.byteLength < 3) throw new CodecError("input too short");
  if (v.getUint8(0) !== MSG.INPUT) throw new CodecError(`not an input: type ${v.getUint8(0)}`);
  if (v.getUint8(1) !== VERSION) throw new CodecError(`unsupported version ${v.getUint8(1)}`);
  const n = v.getUint8(2);
  if (n < 1 || n > 8) throw new CodecError(`bad input count ${n}`);
  if (v.byteLength !== inputSize(n))
    throw new CodecError(`input length ${v.byteLength} ≠ ${inputSize(n)}`);
  const inputs = [];
  for (let k = 0, o = 3; k < n; k++, o += 6) {
    const buttons = v.getUint8(o + 4);
    const turn = v.getInt8(o + 5);
    if (buttons > 3) throw new CodecError("unknown button bits");
    if (turn < -127) throw new CodecError("turn out of range");
    inputs.push({
      seq: v.getUint32(o, true),
      thrust: Boolean(buttons & 1),
      fire: Boolean(buttons & 2),
      turn: turn / 127,
    });
  }
  return { type: "input", inputs };
}

/** Accept ArrayBuffer, any typed array, or a Node Buffer (which may be a slice of a pool). */
function toView(buf) {
  if (buf instanceof ArrayBuffer) return new DataView(buf);
  if (ArrayBuffer.isView(buf)) return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  throw new CodecError("expected binary data");
}
