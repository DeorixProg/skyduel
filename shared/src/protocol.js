/**
 * Protocol v1 — control messages are JSON text frames; game messages
 * (inputs up, snapshots down) are binary frames (codec/binary.js) or, with
 * the JSON codec selected at join, JSON text frames of the same shape.
 *
 * Client → server
 *   { type: "join", room: string(1..32), name: string(1..16), codec?: "binary" | "json" }
 *   { type: "input", inputs: [{ seq, thrust, turn, fire }] }      (JSON codec only)
 *   { type: "chat", text: string(1..200) }
 *   { type: "leave" }
 *   { type: "ping", t: number }
 *
 * Server → client
 *   { type: "welcome", v, playerId, shipId, seed, tickRate, codec, room }
 *   { type: "snapshot", tick, ack, entities }                      (JSON codec only)
 *   { type: "roster",  players: [{ id, name }] }
 *   { type: "chat",    from, name, text, t }
 *   { type: "pong",    t }
 *   { type: "error",   code, message }
 *   { type: "shutdown" }
 *
 * Every incoming frame is validated. Anything unexpected closes the socket
 * with an application close code (4000–4999) and is logged.
 */
export const PROTOCOL_VERSION = 1;

export const CLOSE = Object.freeze({
  GOING_AWAY: 1001, // server shutdown
  TOO_BIG: 1009, // set by ws itself when maxPayload is exceeded
  BAD_JSON: 4000,
  UNKNOWN_TYPE: 4001,
  BAD_SHAPE: 4002,
  JOIN_TIMEOUT: 4003,
  ROOM_FULL: 4004,
  NO_SUCH_ROOM: 4005,
  ALREADY_JOINED: 4006,
  RATE_LIMIT: 4008,
  SLOW_CLIENT: 4009,
  HEARTBEAT: 4010,
});

const isStr = (v, min, max) => typeof v === "string" && v.length >= min && v.length <= max;

/** Per-type shape checks: return an error string or null. */
const SHAPES = {
  join: (m) =>
    !isStr(m.room, 1, 32) || !/^[\w-]+$/.test(m.room)
      ? "room must be 1..32 chars of [A-Za-z0-9_-]"
      : !isStr(m.name?.trim?.(), 1, 16)
        ? "name must be 1..16 chars"
        : m.codec !== undefined && m.codec !== "binary" && m.codec !== "json"
          ? 'codec must be "binary" or "json"'
          : null,
  chat: (m) => (!isStr(m.text?.trim?.(), 1, 200) ? "text must be 1..200 chars" : null),
  leave: () => null,
  input: (m) => {
    if (!Array.isArray(m.inputs) || m.inputs.length < 1 || m.inputs.length > 8)
      return "inputs: 1..8 items";
    for (const i of m.inputs) {
      if (!Number.isInteger(i?.seq) || i.seq < 0 || i.seq > 0xffffffff) return "seq: uint32";
      if (typeof i.thrust !== "boolean" || typeof i.fire !== "boolean")
        return "thrust/fire: boolean";
      if (typeof i.turn !== "number" || !(i.turn >= -1 && i.turn <= 1)) return "turn: -1..1";
    }
    return null;
  },
  ping: (m) =>
    typeof m.t !== "number" || !Number.isFinite(m.t) ? "t must be a finite number" : null,
};

/**
 * Parse and validate one raw frame. Never throws.
 * @returns {{ ok: true, msg: object } | { ok: false, code: number, reason: string }}
 */
export function parseMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    return { ok: false, code: CLOSE.BAD_JSON, reason: "invalid JSON" };
  }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return { ok: false, code: CLOSE.BAD_SHAPE, reason: "message must be an object" };
  }
  const check = Object.hasOwn(SHAPES, msg.type) ? SHAPES[msg.type] : null;
  if (!check)
    return {
      ok: false,
      code: CLOSE.UNKNOWN_TYPE,
      reason: `unknown type ${JSON.stringify(msg.type)}`,
    };
  const err = check(msg);
  if (err) return { ok: false, code: CLOSE.BAD_SHAPE, reason: `${msg.type}: ${err}` };
  return { ok: true, msg };
}
