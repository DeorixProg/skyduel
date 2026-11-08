import { integrate } from "../sim/ship.js";

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;

/** Re-apply inputs, in order, on top of a ship state. Pure. */
export function replay(state, inputs, dt = DT) {
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
export function reconcile({ server, ack, pending, dt = DT }) {
  const rest = pending.filter((i) => i.seq > ack);
  return { state: replay(server, rest, dt), pending: rest };
}
