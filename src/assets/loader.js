/**
 * Asset pipeline. Every loader takes an AbortSignal; every request has its own
 * timeout; transient failures are retried with exponential backoff + jitter;
 * client errors (4xx) and corrupt data are never retried — repeating them
 * cannot help.
 */

export class HttpError extends Error {
  constructor(url, status) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Should this failure be retried? */
export function isRetryable(err, signal) {
  if (signal?.aborted) return false; // the CALLER gave up: stop immediately
  if (err instanceof HttpError) return err.status >= 500 || err.status === 429;
  if (err?.name === "TimeoutError") return true; // per-request timeout
  if (err instanceof TypeError) return true; // fetch network failure
  return false; // SyntaxError (bad JSON), decode errors, AbortError, …
}

export async function withRetry(fn, { attempts = 3, baseMs = 200, signal, onRetry } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryable(err, signal)) throw err;
      // full jitter: random in [0, base·2^(n-1)) — retries of many clients do not synchronise
      const delay = Math.random() * baseMs * 2 ** (attempt - 1);
      onRetry?.({ attempt, delay, err });
      await sleep(delay, signal);
    }
  }
  throw lastError;
}

/** fetch with an outer AbortSignal AND a per-request timeout; checks `ok`. */
export async function fetchOk(url, { signal, timeoutMs = 4000 } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const res = await fetch(url, { signal: AbortSignal.any(signals) });
  if (!res.ok) throw new HttpError(url, res.status);
  return res;
}

export async function fetchJson(url, opts) {
  const res = await fetchOk(url, opts);
  return res.json(); // throws SyntaxError on corrupt JSON — not retryable
}

/** fetch → Blob → ImageBitmap: unlike `new Image()`, this path is abortable. */
export async function fetchImage(url, opts) {
  const res = await fetchOk(url, opts);
  return createImageBitmap(await res.blob());
}

/** fetch → ArrayBuffer → AudioBuffer, decoded during loading (not on first play). */
export async function fetchAudio(audioCtx, url, opts) {
  const res = await fetchOk(url, opts);
  return audioCtx.decodeAudioData(await res.arrayBuffer());
}

export const loadJson = (url, opts = {}) => withRetry(() => fetchJson(url, opts), opts);
export const loadImage = (url, opts = {}) => withRetry(() => fetchImage(url, opts), opts);
export const loadAudio = (audioCtx, url, opts = {}) =>
  withRetry(() => fetchAudio(audioCtx, url, opts), opts);

/**
 * Load everything in the manifest.
 *  - concurrent (default): Promise.all over all items; per-item progress.
 *  - sequential: one `await` after another — kept only for the timing comparison.
 * Optional items that fail resolve to `null` (the game uses a fallback);
 * a failing required item rejects the whole load.
 */
export async function loadAll(
  manifest,
  { audioCtx, signal, onProgress, onRetry, sequential = false, rewrite = (item) => item.url },
) {
  const items = [
    ...manifest.images.map((i) => ({ ...i, type: "image" })),
    ...manifest.sounds.map((i) => ({ ...i, type: "sound" })),
    ...manifest.json.map((i) => ({ ...i, type: "json" })),
  ];
  let done = 0;
  const report = (item, state, error) => {
    if (state !== "loading") done++;
    onProgress?.({ done, total: items.length, item: item.id, state, error });
  };

  const loadOne = async (item) => {
    const opts = { signal, timeoutMs: item.timeoutMs ?? 4000 };
    const fetchOne = (attempt) => {
      const url = rewrite(item, attempt); // hook for the fault-injection experiments
      if (item.type === "image") return fetchImage(url, opts);
      if (item.type === "sound") return fetchAudio(audioCtx, url, opts);
      return fetchJson(url, opts);
    };
    report(item, "loading");
    try {
      const value = await withRetry(fetchOne, {
        attempts: 3,
        baseMs: 200,
        signal,
        onRetry: (info) => onRetry?.({ item: item.id, ...info }),
      });
      report(item, "ok");
      return [item.id, value];
    } catch (err) {
      if (signal?.aborted || item.required) {
        report(item, "failed", err);
        throw err;
      }
      report(item, "skipped", err);
      return [item.id, null];
    }
  };

  const t0 = performance.now();
  let entries;
  if (sequential) {
    entries = [];
    for (const item of items) entries.push(await loadOne(item));
  } else {
    entries = await Promise.all(items.map(loadOne));
  }
  return { assets: Object.fromEntries(entries), ms: performance.now() - t0 };
}
