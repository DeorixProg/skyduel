/**
 * Web Audio. The AudioContext is created early (it starts "suspended" under
 * the autoplay policy) so buffers can be DECODED during loading; it is
 * resumed on the first user gesture (the "Join" click). Sound is subscribed
 * to the world's event bus — the simulation never imports this module.
 */
export function createAudio() {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  const buffers = new Map();

  function play(name, { volume = 1, pan = 0, rate = 1 } = {}) {
    const buffer = buffers.get(name);
    if (!buffer || ctx.state !== "running") return; // missing sound = silent, never a crash
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(gain).connect(panner).connect(master);
    src.start();
  }

  return {
    ctx,
    setBuffers(map) {
      for (const [k, v] of Object.entries(map)) if (v) buffers.set(k, v);
    },
    /** Must be called from inside a user-gesture handler. */
    unlock: () => ctx.resume(),
    play,
    /** Subscribe to game events. Returns an unsubscribe function. */
    attach(bus, { panOf = () => 0, localId = 0 } = {}) {
      const ac = new AbortController();
      const on = (type, fn) => bus.addEventListener(type, fn, { signal: ac.signal });
      on("fired", (e) =>
        play("shoot", { volume: e.detail.by === localId ? 0.5 : 0.25, pan: panOf(e.detail.by) }),
      );
      on("hit", (e) => play("hit", { volume: 0.6, pan: panOf(e.detail.target) }));
      on("exploded", (e) => play("explosion", { volume: 0.9, pan: panOf(e.detail.target) }));
      on("popped", () => play("explosion", { volume: 0.4, rate: 1.6 }));
      on("pickup", () => play("pickup", { volume: 0.6 }));
      return () => ac.abort();
    },
  };
}
