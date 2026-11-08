/**
 * Token bucket: `rate` tokens per second, at most `burst` stored.
 * Each message costs one token; an empty bucket means "too fast".
 * `now` is injectable so tests can drive time.
 */
export interface TokenBucket {
  take(cost?: number): boolean;
  readonly tokens: number;
}

export function createTokenBucket({
  rate,
  burst,
  now = () => performance.now(),
}: {
  rate: number;
  burst: number;
  now?: () => number;
}): TokenBucket {
  let tokens = burst;
  let last = now();
  return {
    take(cost = 1) {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * rate);
      last = t;
      if (tokens < cost) return false;
      tokens -= cost;
      return true;
    },
    get tokens() {
      return tokens;
    },
  };
}
