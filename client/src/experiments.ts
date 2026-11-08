import type { LoopMode } from "./loop.ts";

/**
 * Lab 1, M4: "break it on purpose". Each experiment is selected by the query
 * string, so it can be reproduced and measured without editing the code:
 *
 *   ?exp=block     busy-wait 100 ms in render every 60th frame
 *   ?exp=interval  setInterval(frame, 16) instead of requestAnimationFrame
 *   ?exp=variable  variable timestep: simulate(dt) once per frame
 *   ?autopilot=1   hold thrust (+ slight turn) for exactly 5 simulated seconds, log position
 */
const params = new URLSearchParams(location.search);
export const EXP = params.get("exp") ?? "none";
export const AUTOPILOT = params.has("autopilot");

let frameNo = 0;
export function maybeBlock() {
  if (EXP !== "block") return;
  frameNo++;
  if (frameNo % 60 === 0) {
    const t = performance.now();
    while (performance.now() < t + 100) {
      // the whole page is frozen here: no input, no paint, no timers
    }
  }
}

export function loopMode(): LoopMode {
  if (EXP === "interval") return "interval";
  if (EXP === "variable") return "variable";
  return "raf";
}

/** Frame-interval recorder, exposed on window for the measurement scripts. */
export interface FrameSummary {
  n: number;
  mean: number;
  sd: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface Recorder {
  readonly frames: readonly number[];
  mark(t: number): void;
  reset(): void;
  summary(): FrameSummary;
}

export function createRecorder(capacity = 1 << 16): Recorder {
  // fixed ring of doubles: recording a frame must not allocate (Lab 7 found the growing
  // number[] being re-allocated in old space and feeding major GCs)
  const ring = new Float64Array(capacity);
  let count = 0;
  let prev = 0;
  const values = (): number[] => Array.from(ring.subarray(0, Math.min(count, capacity)));
  return {
    get frames() {
      return values();
    },
    mark(t: number) {
      if (prev) ring[count++ % capacity] = t - prev;
      prev = t;
    },
    reset() {
      count = 0;
      prev = 0;
    },
    summary() {
      const s = values().sort((x, y) => x - y);
      const pct = (p: number): number =>
        s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
      const mean = s.reduce((x, y) => x + y, 0) / (s.length || 1);
      const sd = Math.sqrt(s.reduce((x, y) => x + (y - mean) ** 2, 0) / (s.length || 1));
      return {
        n: s.length,
        mean,
        sd,
        p50: pct(50),
        p95: pct(95),
        p99: pct(99),
        max: s.at(-1) ?? 0,
      };
    },
  };
}
