import type { Bus } from "@skyduel/shared/bus.ts";
import type { SimEvents } from "@skyduel/shared/sim/world.ts";
import type { EntityId } from "@skyduel/shared/types.ts";

export type SoundName = "shoot" | "hit" | "explosion" | "pickup";

export interface Audio {
  readonly ctx: AudioContext;
  setBuffers(buffers: Partial<Record<string, AudioBuffer | null>>): void;
  unlock(): Promise<void>;
  play(name: SoundName, opts?: { volume?: number; pan?: number; rate?: number }): void;
  attach(
    bus: Bus<SimEvents>,
    opts?: { panOf?: (id: EntityId) => number; localId?: EntityId },
  ): () => void;
}

/**
 * Web Audio. The AudioContext is created early (it starts "suspended" under
 * the autoplay policy) so buffers can be DECODED during loading; it is
 * resumed on the first user gesture. Sound subscribes to the typed event
 * bus — the simulation never imports this module.
 */
export function createAudio(): Audio {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  const buffers = new Map<string, AudioBuffer>();

  const play: Audio["play"] = (name, { volume = 1, pan = 0, rate = 1 } = {}) => {
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
  };

  return {
    ctx,
    setBuffers(map) {
      for (const [k, v] of Object.entries(map)) if (v) buffers.set(k, v);
    },
    unlock: () => ctx.resume(),
    play,
    attach(bus, { panOf = () => 0, localId } = {}) {
      const ac = new AbortController();
      const opts = { signal: ac.signal };
      bus.on(
        "fired",
        (d) => play("shoot", { volume: d.by === localId ? 0.5 : 0.25, pan: panOf(d.by) }),
        opts,
      );
      bus.on("hit", (d) => play("hit", { volume: 0.6, pan: panOf(d.target) }), opts);
      bus.on("exploded", (d) => play("explosion", { volume: 0.9, pan: panOf(d.target) }), opts);
      bus.on("popped", () => play("explosion", { volume: 0.4, rate: 1.6 }), opts);
      bus.on("pickup", () => play("pickup", { volume: 0.6 }), opts);
      return () => ac.abort();
    },
  };
}
