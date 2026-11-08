import { z } from "zod";

/**
 * Asset pipeline. Every loader takes an AbortSignal; every request has its own
 * timeout; transient failures are retried with exponential backoff + jitter;
 * client errors (4xx) and corrupt data are never retried — repeating them
 * cannot help.
 */

export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly status: number;
  readonly url: string;
  constructor(url: string, status: number) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.url = url;
  }
}

const ItemSchema = z.object({
  id: z.string(),
  url: z.string(),
  required: z.boolean().default(false),
  timeoutMs: z.number().positive().optional(),
});
export const ManifestSchema = z.object({
  version: z.number(),
  images: z.array(ItemSchema),
  sounds: z.array(ItemSchema),
  json: z.array(ItemSchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;
type ItemType = "image" | "sound" | "json";
export type ManifestItem = z.infer<typeof ItemSchema> & { type: ItemType };

export interface RetryInfo {
  attempt: number;
  delay: number;
  err: unknown;
}

export interface FetchOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
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

/** Should this failure be retried? `err` is unknown: anything can be thrown. */
export function isRetryable(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false; // the CALLER gave up: stop immediately
  if (err instanceof HttpError) return err.status >= 500 || err.status === 429;
  if (err instanceof DOMException && err.name === "TimeoutError") return true; // per-request timeout
  if (err instanceof TypeError) return true; // fetch network failure
  return false; // SyntaxError (bad JSON), decode errors, AbortError, …
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  {
    attempts = 3,
    baseMs = 200,
    signal,
    onRetry,
  }: {
    attempts?: number;
    baseMs?: number;
    signal?: AbortSignal | undefined;
    onRetry?: ((info: RetryInfo) => void) | undefined;
  } = {},
): Promise<T> {
  let lastError: unknown = new Error("withRetry: attempts must be ≥ 1");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err: unknown) {
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
export async function fetchOk(
  url: string,
  { signal, timeoutMs = 4000 }: FetchOptions = {},
): Promise<Response> {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const res = await fetch(url, { signal: AbortSignal.any(signals) });
  if (!res.ok) throw new HttpError(url, res.status);
  return res;
}

/** Returns `unknown`: the caller must validate (zod) before using the data. */
export async function fetchJson(url: string, opts?: FetchOptions): Promise<unknown> {
  const res = await fetchOk(url, opts);
  return res.json(); // throws SyntaxError on corrupt JSON — not retryable
}

/** fetch → Blob → ImageBitmap: unlike `new Image()`, this path is abortable. */
export async function fetchImage(url: string, opts?: FetchOptions): Promise<ImageBitmap> {
  const res = await fetchOk(url, opts);
  return createImageBitmap(await res.blob());
}

/** fetch → ArrayBuffer → AudioBuffer, decoded during loading (not on first play). */
export async function fetchAudio(
  audioCtx: BaseAudioContext,
  url: string,
  opts?: FetchOptions,
): Promise<AudioBuffer> {
  const res = await fetchOk(url, opts);
  return audioCtx.decodeAudioData(await res.arrayBuffer());
}

export const loadJson = (
  url: string,
  opts: FetchOptions & { attempts?: number; onRetry?: (i: RetryInfo) => void } = {},
) => withRetry(() => fetchJson(url, opts), opts);

export interface LoadedAssets {
  readonly images: ReadonlyMap<string, ImageBitmap | null>;
  readonly sounds: ReadonlyMap<string, AudioBuffer | null>;
  readonly json: ReadonlyMap<string, unknown>;
}

export interface Progress {
  done: number;
  total: number;
  item: string;
  state: "loading" | "ok" | "skipped" | "failed";
  error?: unknown;
}

type Loaded =
  | { type: "image"; id: string; value: ImageBitmap | null }
  | { type: "sound"; id: string; value: AudioBuffer | null }
  | { type: "json"; id: string; value: unknown };

/**
 * Load everything in the manifest.
 *  - concurrent (default): Promise.all over all items; per-item progress.
 *  - sequential: one `await` after another — kept only for the timing comparison.
 * Optional items that fail resolve to `null` (the game uses a fallback);
 * a failing required item rejects the whole load.
 */
export async function loadAll(
  manifest: Manifest,
  {
    audioCtx,
    signal,
    onProgress,
    onRetry,
    sequential = false,
    rewrite = (item) => item.url,
  }: {
    audioCtx: BaseAudioContext;
    signal?: AbortSignal;
    onProgress?: (p: Progress) => void;
    onRetry?: (info: RetryInfo & { item: string }) => void;
    sequential?: boolean;
    rewrite?: (item: ManifestItem, attempt: number) => string;
  },
): Promise<{ assets: LoadedAssets; ms: number }> {
  const items: ManifestItem[] = [
    ...manifest.images.map((i) => ({ ...i, type: "image" as const })),
    ...manifest.sounds.map((i) => ({ ...i, type: "sound" as const })),
    ...manifest.json.map((i) => ({ ...i, type: "json" as const })),
  ];
  let done = 0;
  const report = (item: ManifestItem, state: Progress["state"], error?: unknown) => {
    if (state !== "loading") done++;
    onProgress?.({ done, total: items.length, item: item.id, state, error });
  };

  const loadOne = async (item: ManifestItem): Promise<Loaded> => {
    const opts: FetchOptions = { signal, timeoutMs: item.timeoutMs ?? 4000 };
    const url = (attempt: number) => rewrite(item, attempt); // hook for the fault-injection experiments
    const retry = {
      attempts: 3,
      baseMs: 200,
      signal,
      onRetry: (info: RetryInfo) => onRetry?.({ item: item.id, ...info }),
    };
    report(item, "loading");
    try {
      let loaded: Loaded;
      switch (item.type) {
        case "image":
          loaded = {
            type: "image",
            id: item.id,
            value: await withRetry((a) => fetchImage(url(a), opts), retry),
          };
          break;
        case "sound":
          loaded = {
            type: "sound",
            id: item.id,
            value: await withRetry((a) => fetchAudio(audioCtx, url(a), opts), retry),
          };
          break;
        case "json":
          loaded = {
            type: "json",
            id: item.id,
            value: await withRetry((a) => fetchJson(url(a), opts), retry),
          };
          break;
      }
      report(item, "ok");
      return loaded;
    } catch (err: unknown) {
      if (signal?.aborted || item.required) {
        report(item, "failed", err);
        throw err;
      }
      report(item, "skipped", err);
      return { type: item.type, id: item.id, value: null };
    }
  };

  const t0 = performance.now();
  let results: Loaded[];
  if (sequential) {
    results = [];
    for (const item of items) results.push(await loadOne(item));
  } else {
    results = await Promise.all(items.map(loadOne));
  }
  const images = new Map<string, ImageBitmap | null>();
  const sounds = new Map<string, AudioBuffer | null>();
  const json = new Map<string, unknown>();
  for (const r of results) {
    if (r.type === "image") images.set(r.id, r.value);
    else if (r.type === "sound") sounds.set(r.id, r.value);
    else json.set(r.id, r.value);
  }
  return { assets: { images, sounds, json }, ms: performance.now() - t0 };
}
