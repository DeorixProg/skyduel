/**
 * Fixed-timestep game loop ("Fix Your Timestep!", G. Fiedler).
 *
 * The simulation advances in exact `step`-second increments, however often the
 * browser paints. `render(alpha)` receives the fraction of a step that has
 * accumulated but not yet been simulated, so it can interpolate between the
 * previous and the current state.
 *
 * `mode` exists only for the Lab 1 experiments:
 *   "raf"      — requestAnimationFrame + accumulator (the correct loop)
 *   "interval" — setInterval(frame, 16) instead of rAF       (experiment 2)
 *   "variable" — rAF, but simulate(dt) once per frame        (experiment 3)
 */
export type LoopMode = "raf" | "interval" | "variable";

export interface LoopStats {
  stepsPerSec: number;
  framesPerSec: number;
  frameMs: number;
  workMs: number;
  totalSteps: number;
}

export interface LoopOptions {
  step?: number;
  simulate: (dt: number) => void;
  render: (alpha: number, stats: Readonly<LoopStats>) => void;
  maxFrame?: number;
  mode?: LoopMode;
  now?: () => number;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
  setInterval?: (cb: () => void, ms: number) => number;
  clearInterval?: (id: number) => void;
}

export interface Loop {
  readonly stats: Readonly<LoopStats>;
  start(): void;
  stop(): void;
}

export function createLoop({
  step = 1 / 60,
  simulate,
  render,
  maxFrame = 0.25,
  mode = "raf",
  now = () => performance.now(),
  raf = (cb) => requestAnimationFrame(cb),
  caf = (id) => cancelAnimationFrame(id),
  setInterval: setIntervalFn = (cb, ms) => window.setInterval(cb, ms),
  clearInterval: clearIntervalFn = (id) => window.clearInterval(id),
}: LoopOptions): Loop {
  let accumulator = 0;
  let last = 0;
  let handle = 0;
  let running = false;

  // counters for the HUD: reset once per second
  let windowStart = 0;
  let stepsInWindow = 0;
  let framesInWindow = 0;
  const stats: LoopStats = {
    stepsPerSec: 0,
    framesPerSec: 0,
    frameMs: 0,
    workMs: 0,
    totalSteps: 0,
  };

  function frame(timestamp: number = now()): void {
    const t = mode === "interval" ? now() : timestamp;
    const delta = Math.min((t - last) / 1000, maxFrame); // clamp: no spiral of death
    stats.frameMs = t - last;
    last = t;

    if (mode === "variable") {
      simulate(delta);
      stepsInWindow++;
      stats.totalSteps++;
    } else {
      accumulator += delta;
      while (accumulator >= step) {
        simulate(step);
        accumulator -= step;
        stepsInWindow++;
        stats.totalSteps++;
      }
    }

    render(mode === "variable" ? 1 : accumulator / step, stats);
    framesInWindow++;
    stats.workMs = now() - t;

    if (t - windowStart >= 1000) {
      const secs = (t - windowStart) / 1000;
      stats.stepsPerSec = stepsInWindow / secs;
      stats.framesPerSec = framesInWindow / secs;
      stepsInWindow = 0;
      framesInWindow = 0;
      windowStart = t;
    }

    if (running && mode !== "interval") handle = raf(frame);
  }

  return {
    stats,
    start() {
      if (running) return;
      running = true;
      last = windowStart = now();
      accumulator = 0;
      handle = mode === "interval" ? setIntervalFn(() => frame(), 16) : raf(frame);
    },
    stop() {
      running = false;
      if (mode === "interval") clearIntervalFn(handle);
      else caf(handle);
    },
  };
}
