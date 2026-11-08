/** JSON codec with the same message shapes as the binary one — kept behind a flag for comparison. */
export function encodeSnapshot(snap, ack) {
  return JSON.stringify({ type: "snapshot", tick: snap.tick, ack, entities: snap.entities });
}

export function decodeSnapshot(text) {
  const msg = typeof text === "string" ? JSON.parse(text) : text;
  return msg;
}

export function encodeInputs(inputs) {
  return JSON.stringify({ type: "input", inputs });
}
