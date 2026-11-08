import { z } from "zod";
import type { Effect } from "./sim/entity.ts";
import { entityId, playerId, type Result, seq, tick } from "./types.ts";

/**
 * Protocol v2 — the single source of truth for every JSON message.
 * Zod schemas → inferred TypeScript types → runtime validation at every
 * boundary. Types are erased at build time; data from the network is still
 * `unknown` until a schema has accepted it.
 *
 * Game messages (inputs up, snapshots down) are binary frames by default
 * (codec/binary.ts); with the JSON codec they are the `input`/`snapshot`
 * messages below.
 */
export const PROTOCOL_VERSION = 2;

export const CLOSE = Object.freeze({
  NORMAL: 1000,
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
export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

// ── building blocks (number → branded type after validation) ─────────────────
const uint32 = z.number().int().min(0).max(0xffffffff);
const SeqSchema = uint32.transform(seq);
const TickSchema = uint32.transform(tick);
const EntityIdSchema = z.number().int().min(1).max(0xffff).transform(entityId);
const PlayerIdSchema = z.number().int().min(1).transform(playerId);
const EffectSchema = z.enum(["shield", "rapid", "homing"]) satisfies z.ZodType<Effect>;
const finite = z.number().finite();

export const InputSchema = z.object({
  seq: SeqSchema,
  thrust: z.boolean(),
  turn: z.number().min(-1).max(1),
  fire: z.boolean(),
});

// ── client → server ──────────────────────────────────────────────────────────
export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("join"),
    room: z.string().regex(/^[\w-]{1,32}$/, "room must be 1..32 chars of [A-Za-z0-9_-]"),
    name: z.string().trim().min(1).max(16),
    codec: z.enum(["binary", "json"]).default("binary"),
  }),
  z.object({ type: z.literal("chat"), text: z.string().trim().min(1).max(200) }),
  z.object({ type: z.literal("leave") }),
  z.object({ type: z.literal("ping"), t: finite }),
  z.object({ type: z.literal("input"), inputs: z.array(InputSchema).min(1).max(8) }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
/** What a client may SEND (before defaults/transforms are applied by the server's parse). */
export type ClientMessageIn = z.input<typeof ClientMessageSchema>;

// ── server → client ──────────────────────────────────────────────────────────
const base = { id: EntityIdSchema, x: finite, y: finite, vx: finite, vy: finite, angle: finite };
export const EntityDataSchema = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("ship"),
    hp: z.number(),
    score: z.number(),
    down: z.boolean(),
    thrust: z.boolean(),
    effects: z.array(EffectSchema),
  }),
  z.object({
    ...base,
    kind: z.literal("bullet"),
    owner: EntityIdSchema,
    seq: SeqSchema,
    homing: z.boolean(),
  }),
  z.object({ ...base, kind: z.literal("balloon"), radius: z.number(), hunter: z.boolean() }),
  z.object({ ...base, kind: z.literal("pickup"), effect: EffectSchema }),
]);

export const RoomInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  players: z.number(),
  maxPlayers: z.number(),
  arena: z.string(),
});
export type RoomInfo = z.infer<typeof RoomInfoSchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    v: z.number(),
    playerId: PlayerIdSchema,
    shipId: EntityIdSchema,
    seed: z.number(),
    tickRate: z.number(),
    codec: z.enum(["binary", "json"]),
    netsim: z.object({ lag: z.number(), jitter: z.number(), drop: z.number() }),
    room: RoomInfoSchema,
  }),
  z.object({
    type: z.literal("roster"),
    players: z.array(
      z.object({ id: PlayerIdSchema, name: z.string(), shipId: EntityIdSchema, color: z.string() }),
    ),
  }),
  z.object({
    type: z.literal("chat"),
    from: PlayerIdSchema,
    name: z.string(),
    text: z.string(),
    t: z.number(),
  }),
  z.object({ type: z.literal("pong"), t: z.number() }),
  z.object({ type: z.literal("error"), code: z.number(), message: z.string() }),
  z.object({ type: z.literal("shutdown") }),
  z.object({
    type: z.literal("snapshot"),
    tick: TickSchema,
    ack: SeqSchema,
    entities: z.array(EntityDataSchema),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

/** What arrives on the wire is `unknown`: a string, a Buffer, an ArrayBuffer… */
function toText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return null;
}

export interface ParseError {
  readonly code: CloseCode;
  readonly reason: string;
}

function parseWith<T>(schema: z.ZodType<T>, data: unknown): Result<T, ParseError> {
  const text = toText(data);
  if (text === null)
    return { ok: false, error: { code: CLOSE.BAD_SHAPE, reason: "expected a text frame" } };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: { code: CLOSE.BAD_JSON, reason: "invalid JSON" } };
  }
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  const issue = result.error.issues[0];
  const unknownType =
    issue?.code === "invalid_union" && issue.path.length === 1 && issue.path[0] === "type";
  return {
    ok: false,
    error: {
      code: unknownType ? CLOSE.UNKNOWN_TYPE : CLOSE.BAD_SHAPE,
      reason: issue ? `${issue.path.join(".") || "message"}: ${issue.message}` : "invalid message",
    },
  };
}

/** Never throws: bad input becomes a typed error the caller logs and closes on. */
export const parseClientMessage = (data: unknown): Result<ClientMessage, ParseError> =>
  parseWith(ClientMessageSchema, data);

export const parseServerMessage = (data: unknown): Result<ServerMessage, ParseError> =>
  parseWith(ServerMessageSchema, data);
