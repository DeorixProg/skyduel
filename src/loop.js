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
export function createLoop({
  step = 1 / 60,
  simulate,
  render,
  maxFrame = 0.25,
  mode = "raf",
  now = () => performance.now(),
  raf = (cb) => requestAnimationFrame(cb),
  caf = (id) => cancelAnimationFrame(id),
}) {
  let accumulator = 0;
  let last = 0;
  let handle = 0;
  let running = false;

  // counters for the HUD: reset once per second
  let windowStart = 0;
  let stepsInWindow = 0;
  let framesInWindow = 0;
  const stats = { stepsPerSec: 0, framesPerSec: 0, frameMs: 0, workMs: 0, totalSteps: 0 };

  function frame(timestamp = now()) {
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
      handle = mode === "interval" ? setInterval(frame, 16) : raf(frame);
    },
    stop() {
      running = false;
      if (mode === "interval") clearInterval(handle);
      else caf(handle);
    },
  };
}
