import { integrate, type ShipBody } from "../sim/ship.ts";
import type { Input, Seq } from "../types.ts";

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;

/** Re-apply inputs, in order, on top of a ship state. Pure. */
export function replay(state: ShipBody, inputs: readonly Input[], dt = DT): ShipBody {
  let s = state;
  for (const input of inputs) s = integrate(s, input, dt);
  return s;
}

/**
 * Server reconciliation (Gambetta, part 2), as a pure function:
 * take the authoritative state, drop every input the server has already
 * applied (seq ≤ ack), replay the rest. If prediction was right, the result
 * equals what the client already shows.
 */
export function reconcile({
  server,
  ack,
  pending,
  dt = DT,
}: {
  server: ShipBody;
  ack: Seq;
  pending: readonly Input[];
  dt?: number;
}): { state: ShipBody; pending: Input[] } {
  const rest = pending.filter((i) => i.seq > ack);
  return { state: replay(server, rest, dt), pending: rest };
}
