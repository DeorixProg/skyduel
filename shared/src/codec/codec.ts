import type { ClientSnapshot, Snapshot } from "../snapshot.ts";
import type { Input, Seq } from "../types.ts";

export type Frame = ArrayBuffer | string;

/** One interface, two implementations (binary and JSON), switchable at join time. */
export interface Codec {
  readonly name: "binary" | "json";
  encodeSnapshot(snap: Snapshot, ack: Seq): Frame;
  /** Validates; throws CodecError on anything malformed. */
  decodeSnapshot(data: unknown): ClientSnapshot;
  encodeInputs(inputs: readonly Input[]): Frame;
  /** Validates; throws CodecError on anything malformed. */
  decodeInputs(data: unknown): readonly Input[];
}

export class CodecError extends Error {
  override readonly name = "CodecError";
}
