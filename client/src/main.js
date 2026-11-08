import { loadAll, loadJson } from "./assets/loader.js";
import { createAudio } from "./audio.js";
import { startGame } from "./game.js";
import { createInput } from "./input.js";
import { Lobby } from "./lobby/lobby.js";
import { mountLobbyView } from "./lobby/lobby-view.js";
import { mountRoomView } from "./lobby/room-view.js";
import { Connection, wsUrl } from "./net/connection.js";
import { startNetGame } from "./net/netgame.js";
import { setupCanvas } from "./render/canvas.js";
import { drawLoading } from "./render/loading.js";
import { createSprites } from "./render/sprites.js";

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
const view = setupCanvas(document.getElementById("game"));
const input = createInput(window);
const audio = createAudio();
const retryBtn = document.getElementById("retry");
const lobbyRoot = document.getElementById("lobby");
const roomRoot = document.getElementById("room");

// Autoplay policy: the AudioContext may only start inside a user gesture.
for (const type of ["pointerdown", "keydown"]) {
  window.addEventListener(type, () => audio.unlock(), { once: true });
}

const withQuery = (url, q) => `${url}${url.includes("?") ? "&" : "?"}${q}`;
let cycle = 0;

async function boot() {
  cycle++;
  const faulty = cycle === 1;
  const state = {
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
  const onEsc = (e) => {
    if (e.code === "Escape") ac.abort(new DOMException("скасовано гравцем", "AbortError"));
  };
  window.addEventListener("keydown", onEsc);
  if (faulty && FAIL === "abort") {
    setTimeout(() => ac.abort(new DOMException("скасовано гравцем", "AbortError")), 250);
  }

  const rewrite = (item, attempt) => {
    let url = item.url;
    if (faulty && FAIL === "404" && item.id === "sheet") url = withQuery(url, "status=404");
    if (faulty && FAIL === "503" && item.id === "sheet" && attempt < 3)
      url = withQuery(url, "status=503");
    if (faulty && FAIL === "badjson" && item.id === "atlas") url = "/assets/arenas/broken.json";
    if (NETLAG) url = withQuery(url, `lag=${NETLAG}`);
    return url;
  };
  const onRetry = ({ item, attempt, delay, err }) => {
    const s = state.items.get(item) ?? {};
    state.items.set(item, {
      ...s,
      state: "retry",
      note: `спроба ${attempt} невдала (${err.message}), пауза ${delay.toFixed(0)} мс`,
    });
    console.info("retry", item, attempt, Math.round(delay), err.message);
  };

  try {
    let manifestUrl = "/assets/manifest.json";
    if (faulty && FAIL === "timeout") manifestUrl = withQuery(manifestUrl, "lag=6000");
    state.items.set("manifest", { state: "loading" });
    const manifest = await loadJson(manifestUrl, {
      signal: ac.signal,
      timeoutMs: 1500,
      attempts: 3,
      onRetry: (info) => onRetry({ item: "manifest", ...info }),
    });
    state.items.set("manifest", { state: "ok" });
    for (const group of [manifest.images, manifest.sounds, manifest.json]) {
      for (const i of group) state.items.set(i.id, { state: "pending" });
    }
    const { assets, ms } = await loadAll(manifest, {
      audioCtx: audio.ctx,
      signal: ac.signal,
      sequential: params.get("load") === "seq",
      rewrite,
      onRetry,
      onProgress: ({ done, total, item, state: st, error }) => {
        state.done = done;
        state.total = total;
        state.items.set(item, { state: st, note: error ? `${error.name}: ${error.message}` : "" });
      },
    });
    window.__load = { ms, mode: params.get("load") === "seq" ? "sequential" : "concurrent" };
    console.info("assets loaded in", ms.toFixed(0), "ms");
    audio.setBuffers(assets);
    const sprites = createSprites(assets.sheet, assets.atlas);
    showLobby(sprites);
  } catch (err) {
    state.error =
      err.name === "AbortError"
        ? `Завантаження скасовано (${err.message}).`
        : `Не вдалося завантажити гру: ${err.name}: ${err.message}`;
    retryBtn.hidden = false;
    retryBtn.focus();
  } finally {
    window.removeEventListener("keydown", onEsc);
    setTimeout(() => {
      drawing = false;
    }, 50);
  }
}

function showLobby(sprites) {
  let url = FAIL === "rooms" ? "/api/rooms?lag=5000" : "/api/rooms";
  if (params.has("roomslag")) url = `/api/rooms?lag=${params.get("roomslag")}`;
  const lobby = new Lobby({ url, intervalMs: 3000, timeoutMs: 2000 });
  const lobbyView = mountLobbyView(lobbyRoot, lobby);
  lobby.addEventListener("join", (e) => {
    lobbyView.unmount();
    const { room, arena, name, warning } = e.detail;
    if (warning) console.warn(warning);
    // Lab 5: the match is simulated by the server; ?offline=1 keeps the local game of Labs 1–3.
    if (params.has("offline")) {
      window.__game = startGame({ view, input, sprites, audio, arena, name, params });
      return;
    }
    const netsim = new URLSearchParams();
    for (const k of ["lag", "jitter", "drop"]) if (params.has(k)) netsim.set(k, params.get(k));
    const conn = new Connection(wsUrl(`/ws${netsim.size ? `?${netsim}` : ""}`));
    const codec = params.get("codec") === "json" ? "json" : "binary";
    conn.addEventListener("open", () => conn.send({ type: "join", room: room.id, name, codec }));
    const roomView = mountRoomView(roomRoot, conn, { room, selfName: name });
    conn.addEventListener("welcome", (ev) => {
      window.__game?.stop?.(); // after a reconnect the server gives us a new ship
      window.__game = startNetGame({
        view,
        input,
        sprites,
        audio,
        arena,
        conn,
        welcome: ev.detail,
        params,
      });
    });
    conn.addEventListener("close", (ev) => {
      if (!ev.detail.willRetry && ev.detail.code !== 1000) console.warn("room closed", ev.detail);
    });
    conn.connect();
    window.__conn = conn;
    window.__roomView = roomView;
  });
  lobby.show();
  window.__lobby = lobby;
  if (params.has("autojoin")) {
    lobby.addEventListener("rooms", () => lobby.join(params.get("autojoin") || "somme", "Maksym"), {
      once: true,
    });
  }
}

retryBtn.addEventListener("click", () => {
  retryBtn.hidden = true;
  boot();
});

boot();
