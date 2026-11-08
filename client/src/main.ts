import { loadAll, loadJson, ManifestSchema, type RetryInfo } from "./assets/loader.ts";
import { createAudio } from "./audio.ts";
import { startGame } from "./game.ts";
import { createInput } from "./input.ts";
import { Lobby } from "./lobby/lobby.ts";
import { $, mountLobbyView } from "./lobby/lobby-view.ts";
import { mountRoomView } from "./lobby/room-view.ts";
import { Connection, wsUrl } from "./net/connection.ts";
import { startNetGame } from "./net/netgame.ts";
import { setupCanvas } from "./render/canvas.ts";
import { drawLoading, type LoadingState } from "./render/loading.ts";
import { AtlasSchema, createSprites, type Sprites } from "./render/sprites.ts";

/*
 * Boot sequence: loading screen → lobby → game.
 *
 * Failure gallery (Lab 3), reproducible by query string; faults apply only to
 * the FIRST load attempt, so the Retry button demonstrates recovery:
 *   ?fail=404      sprite sheet answers 404   → not retried, vector fallback, game starts
 *   ?fail=503      sprite sheet answers 503 twice → retried with backoff, then loads
 *   ?fail=timeout  manifest takes 6 s, timeout 1.5 s ×3 → Retry button
 *   ?fail=abort    load aborted after 250 ms (same as pressing Esc) → Retry button
 *   ?fail=badjson  sprite atlas is corrupt JSON → not retried, vector fallback
 *   ?fail=rooms    /api/rooms times out → lobby shows the error and keeps polling
 *   ?roomslag=1500 /api/rooms answers in 1.5 s (to catch a request in flight on leave)
 *   ?netlag=150    every asset response delayed 150 ms (timing experiment)
 *   ?load=seq      sequential awaits instead of Promise.all (timing experiment)
 *
 * Lab 5 network switches:
 *   ?lag=100&jitter=30&drop=0.02   server-side latency injector for this connection
 *   ?codec=json                    JSON snapshots/inputs instead of binary
 *   ?predict=0                     no client-side prediction (ship moves only on snapshots)
 *   ?interp=100                    interpolation delay, ms (also [ and ] keys)
 *   ?chaos=1                       Math.random() inside integrate (determinism-break experiment)
 *   ?offline=1                     the local single-player game from Labs 1–3
 */
const params = new URLSearchParams(location.search);
const FAIL = params.get("fail");
const NETLAG = Number(params.get("netlag") ?? 0);
const view = setupCanvas($(document, "#game", HTMLCanvasElement));
const input = createInput(window);
const audio = createAudio();
const retryBtn = $(document, "#retry", HTMLButtonElement);
const lobbyRoot = $(document, "#lobby", HTMLDivElement);
const roomRoot = $(document, "#room", HTMLDivElement);

// Autoplay policy: the AudioContext may only start inside a user gesture.
for (const type of ["pointerdown", "keydown"] as const) {
  window.addEventListener(type, () => void audio.unlock(), { once: true });
}

const withQuery = (url: string, q: string): string => `${url}${url.includes("?") ? "&" : "?"}${q}`;
const describe = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);
let cycle = 0;

async function boot(): Promise<void> {
  cycle++;
  const faulty = cycle === 1;
  const state: LoadingState = {
    title: "Завантаження ресурсів…",
    done: 0,
    total: 0,
    items: new Map(),
    error: null,
  };
  let drawing = true;
  const paint = () => {
    drawLoading(view.ctx, view, state);
    if (drawing) requestAnimationFrame(paint);
  };
  requestAnimationFrame(paint);

  const ac = new AbortController();
  const onEsc = (e: KeyboardEvent) => {
    if (e.code === "Escape") ac.abort(new DOMException("скасовано гравцем", "AbortError"));
  };
  window.addEventListener("keydown", onEsc);
  if (faulty && FAIL === "abort") {
    setTimeout(() => ac.abort(new DOMException("скасовано гравцем", "AbortError")), 250);
  }

  const rewrite = (item: { id: string; url: string }, attempt: number): string => {
    let url = item.url;
    if (faulty && FAIL === "404" && item.id === "sheet") url = withQuery(url, "status=404");
    if (faulty && FAIL === "503" && item.id === "sheet" && attempt < 3)
      url = withQuery(url, "status=503");
    if (faulty && FAIL === "badjson" && item.id === "atlas") url = "/assets/arenas/broken.json";
    if (NETLAG) url = withQuery(url, `lag=${NETLAG}`);
    return url;
  };
  const onRetry = ({ item, attempt, delay, err }: RetryInfo & { item: string }) => {
    state.items.set(item, {
      state: "retry",
      note: `спроба ${attempt} невдала (${describe(err)}), пауза ${delay.toFixed(0)} мс`,
    });
    console.info("retry", item, attempt, Math.round(delay), describe(err));
  };

  try {
    let manifestUrl = "/assets/manifest.json";
    if (faulty && FAIL === "timeout") manifestUrl = withQuery(manifestUrl, "lag=6000");
    state.items.set("manifest", { state: "loading" });
    const manifest = ManifestSchema.parse(
      await loadJson(manifestUrl, {
        signal: ac.signal,
        timeoutMs: 1500,
        attempts: 3,
        onRetry: (info) => onRetry({ item: "manifest", ...info }),
      }),
    );
    state.items.set("manifest", { state: "ok" });
    for (const group of [manifest.images, manifest.sounds, manifest.json]) {
      for (const i of group) state.items.set(i.id, { state: "pending" });
    }
    const sequential = params.get("load") === "seq";
    const { assets, ms } = await loadAll(manifest, {
      audioCtx: audio.ctx,
      signal: ac.signal,
      sequential,
      rewrite,
      onRetry,
      onProgress: ({ done, total, item, state: st, error }) => {
        state.done = done;
        state.total = total;
        state.items.set(item, { state: st, note: error === undefined ? "" : describe(error) });
      },
    });
    window.__load = { ms, mode: sequential ? "sequential" : "concurrent" };
    console.info("assets loaded in", ms.toFixed(0), "ms");
    audio.setBuffers(Object.fromEntries(assets.sounds));
    const atlas = AtlasSchema.safeParse(assets.json.get("atlas"));
    showLobby(createSprites(assets.images.get("sheet") ?? null, atlas.success ? atlas.data : null));
  } catch (err: unknown) {
    state.error =
      err instanceof DOMException && err.name === "AbortError"
        ? `Завантаження скасовано (${err.message}).`
        : `Не вдалося завантажити гру: ${describe(err)}`;
    retryBtn.hidden = false;
    retryBtn.focus();
  } finally {
    window.removeEventListener("keydown", onEsc);
    setTimeout(() => {
      drawing = false;
    }, 50);
  }
}

function showLobby(sprites: Sprites): void {
  let url = FAIL === "rooms" ? "/api/rooms?lag=5000" : "/api/rooms";
  const roomsLag = params.get("roomslag");
  if (roomsLag) url = `/api/rooms?lag=${roomsLag}`;
  const lobby = new Lobby({ url, intervalMs: 3000, timeoutMs: 2000 });
  const lobbyView = mountLobbyView(lobbyRoot, lobby);
  lobby.events.on("join", ({ room, arena, name, warning }) => {
    lobbyView.unmount();
    if (warning) console.warn(warning);
    // ?offline=1 keeps the local game of Labs 1–3; otherwise the server simulates the match.
    if (params.has("offline")) {
      window.__game = startGame({ view, input, sprites, audio, arena, name, params });
      return;
    }
    const netsim = new URLSearchParams();
    for (const k of ["lag", "jitter", "drop"]) {
      const v = params.get(k);
      if (v !== null) netsim.set(k, v);
    }
    const conn = new Connection(wsUrl(`/ws${netsim.size ? `?${netsim}` : ""}`));
    const codec = params.get("codec") === "json" ? "json" : "binary";
    conn.events.on("open", () => conn.send({ type: "join", room: room.id, name, codec }));
    const roomView = mountRoomView(roomRoot, conn, { room, selfName: name });
    conn.on("welcome", (welcome) => {
      window.__game?.stop(); // after a reconnect the server gives us a new ship
      window.__game = startNetGame({ view, input, sprites, audio, arena, conn, welcome, params });
    });
    conn.events.on("close", (ev) => {
      if (!ev.willRetry && ev.code !== 1000) console.warn("room closed", ev);
    });
    conn.connect();
    window.__conn = conn;
    window.__roomView = roomView;
  });
  lobby.show();
  window.__lobby = lobby;
  if (params.has("autojoin")) {
    const off = lobby.events.on("rooms", () => {
      off();
      void lobby.join(params.get("autojoin") || "somme", "Maksym");
    });
  }
}

retryBtn.addEventListener("click", () => {
  retryBtn.hidden = true;
  void boot();
});

void boot();
