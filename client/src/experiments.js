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

export function loopMode() {
  if (EXP === "interval") return "interval";
  if (EXP === "variable") return "variable";
  return "raf";
}

/** Frame-interval recorder, exposed on window for the measurement scripts. */
export function createRecorder() {
  const frames = [];
  let prev = 0;
  return {
    frames,
    mark(t) {
      if (prev) frames.push(t - prev);
      prev = t;
    },
    reset() {
      frames.length = 0;
      prev = 0;
    },
    summary() {
      const s = [...frames].sort((a, b) => a - b);
      const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
      const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
      const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (s.length || 1));
      return { n: s.length, mean, sd, p50: pct(50), p95: pct(95), p99: pct(99), max: s.at(-1) };
    },
  };
}
