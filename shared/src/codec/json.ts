import { z } from "zod";
import { EntityDataSchema, InputSchema } from "../protocol.ts";
import type { ClientSnapshot, Snapshot } from "../snapshot.ts";
import { type Input, type Seq, seq, tick } from "../types.ts";
import { type Codec, CodecError } from "./codec.ts";

/** JSON codec with the same message shapes as the binary one — kept behind a flag for comparison. */
const SnapshotSchema = z.object({
  type: z.literal("snapshot"),
  tick: z.number().int().min(0).transform(tick),
  ack: z.number().int().min(0).transform(seq),
  entities: z.array(EntityDataSchema),
});
const InputsSchema = z.object({
  type: z.literal("input"),
  inputs: z.array(InputSchema).min(1).max(8),
});

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  let raw: unknown = data;
  if (typeof data === "string") {
    try {
      raw = JSON.parse(data);
    } catch {
      throw new CodecError("invalid JSON");
    }
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new CodecError(r.error.issues[0]?.message ?? "invalid message");
  return r.data;
}

export const jsonCodec: Codec = {
  name: "json",
  encodeSnapshot: (snap: Snapshot, ack: Seq) =>
    JSON.stringify({ type: "snapshot", tick: snap.tick, ack, entities: snap.entities }),
  decodeSnapshot: (data: unknown): ClientSnapshot => parse(SnapshotSchema, data),
  encodeInputs: (inputs: readonly Input[]) => JSON.stringify({ type: "input", inputs }),
  decodeInputs: (data: unknown): readonly Input[] => parse(InputsSchema, data).inputs,
};
