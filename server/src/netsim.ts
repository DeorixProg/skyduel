/**
 * Latency injector for one connection (Lab 5). Configured per socket from the
 * WebSocket URL: /ws?lag=100&jitter=30&drop=0.02
 *   lag     added round-trip time, ms (each direction gets lag/2)
 *   jitter  ± ms of random variation per message (each direction ±jitter/2)
 *   drop    probability that a DROPPABLE message (input, snapshot) is lost
 * Delivery stays in order, like TCP: a message is never delivered before the
 * previous one, so jitter shows up as bunching, not reordering.
 */
export interface NetSimSettings {
  readonly lag: number;
  readonly jitter: number;
  readonly drop: number;
}

export interface Link {
  readonly active: boolean;
  readonly settings: NetSimSettings;
  deliver(fn: () => void, opts?: { droppable?: boolean }): boolean;
}

export function parseNetSim(url: string): NetSimSettings {
  const q = new URL(url, "http://localhost").searchParams;
  const num = (k: string, max: number) => Math.max(0, Math.min(max, Number(q.get(k) ?? 0) || 0));
  return { lag: num("lag", 2000), jitter: num("jitter", 1000), drop: num("drop", 0.9) };
}

export function createLink(
  { lag, jitter, drop }: NetSimSettings,
  random: () => number = Math.random,
): Link {
  const active = lag > 0 || jitter > 0 || drop > 0;
  let lastAt = 0;
  return {
    active,
    settings: { lag, jitter, drop },
    /** Run `fn` after the simulated one-way delay; may drop it. Returns false if dropped. */
    deliver(fn, { droppable = false } = {}) {
      if (!active) {
        fn();
        return true;
      }
      if (droppable && random() < drop) return false;
      const now = performance.now();
      const delay = lag / 2 + (random() - 0.5) * jitter;
      lastAt = Math.max(lastAt, now + Math.max(0, delay));
      setTimeout(fn, lastAt - now);
      return true;
    },
  };
}
