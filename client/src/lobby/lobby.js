import { fetchJson, loadJson } from "../assets/loader.js";

export const DEFAULT_ARENA = Object.freeze({
  name: "Тренувальне небо",
  seed: 22,
  balloons: 6,
  hunters: 1,
  sky: ["#5b9bd5", "#a9d2f0"],
});

/**
 * Lobby model. No DOM here: it fetches, polls and dispatches events
 * ("rooms", "error", "joining", "join"); lobby-view.js renders them.
 *
 * Every request gets AbortSignal.any([leave-signal, AbortSignal.timeout]), so
 * a slow server cannot hang the lobby, and leaving cancels in-flight requests:
 * no orphaned fetches, no "rooms" event arriving after the game started.
 */
export class Lobby extends EventTarget {
  #ac = null;
  #timer = 0;

  constructor({
    url = "/api/rooms",
    intervalMs = 3000,
    timeoutMs = 2000,
    fetchImpl = fetchJson,
  } = {}) {
    super();
    this.url = url;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.rooms = [];
    this.requests = 0; // counters for the README
    this.aborted = 0;
  }

  get active() {
    return this.#ac !== null && !this.#ac.signal.aborted;
  }

  /** Start polling while the lobby is visible. */
  show() {
    if (this.active) return;
    this.#ac = new AbortController();
    this.refresh();
    this.#timer = setInterval(() => this.refresh(), this.intervalMs);
  }

  /** Stop polling and abort whatever is in flight. */
  leave() {
    clearInterval(this.#timer);
    this.#ac?.abort(new DOMException("left the lobby", "AbortError"));
  }

  async refresh() {
    if (!this.active) return;
    const signal = this.#ac.signal;
    this.requests++;
    try {
      const data = await this.fetchImpl(this.url, { signal, timeoutMs: this.timeoutMs });
      if (!Array.isArray(data?.rooms)) throw new TypeError("rooms: unexpected response shape");
      this.rooms = data.rooms;
      this.dispatchEvent(
        new CustomEvent("rooms", { detail: { rooms: this.rooms, at: new Date() } }),
      );
    } catch (err) {
      if (signal.aborted) {
        this.aborted++;
        return; // we left on purpose: not an error
      }
      this.dispatchEvent(new CustomEvent("error", { detail: { error: err } }));
    }
  }

  /** POST /api/rooms; the new room appears in the next refresh. */
  async createRoom(name) {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.any([this.#ac.signal, AbortSignal.timeout(this.timeoutMs)]),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    await this.refresh();
    return body;
  }

  /** Fetch the room's arena config, then leave the lobby and announce the join. */
  async join(roomId, playerName) {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) return;
    this.dispatchEvent(new CustomEvent("joining", { detail: { room } }));
    let arena = DEFAULT_ARENA;
    let warning = null;
    try {
      arena = await loadJson(room.arena, { signal: this.#ac?.signal, timeoutMs: 3000 });
    } catch (err) {
      warning = `Арена «${room.name}» не завантажилась (${err.name}: ${err.message}) — граємо на стандартній`;
    }
    this.leave();
    this.dispatchEvent(
      new CustomEvent("join", { detail: { room, arena, name: playerName || "pilot", warning } }),
    );
  }
}
