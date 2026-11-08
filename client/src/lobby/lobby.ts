import { type ArenaConfig, ArenaSchema, DEFAULT_ARENA } from "@skyduel/shared/arena-config.ts";
import { Bus } from "@skyduel/shared/bus.ts";
import { type RoomInfo, RoomInfoSchema } from "@skyduel/shared/protocol.ts";
import { z } from "zod";
import { type FetchOptions, fetchJson, loadJson } from "../assets/loader.ts";

export interface LobbyEvents {
  rooms: { rooms: readonly RoomInfo[]; at: Date };
  error: { error: unknown };
  joining: { room: RoomInfo };
  join: { room: RoomInfo; arena: ArenaConfig; name: string; warning: string | null };
}

const RoomsResponse = z.object({ rooms: z.array(RoomInfoSchema) });
const CreatedRoom = RoomInfoSchema;
const ErrorBody = z.object({ error: z.string() });

/**
 * Lobby model. No DOM here: it fetches, polls and emits typed events
 * ("rooms", "error", "joining", "join"); lobby-view.ts renders them.
 * (Lab 3 had `class Lobby extends EventTarget`; Lab 6 keeps the same events
 * on a typed Bus, so a listener knows the shape of `detail` at compile time.)
 *
 * Every request gets AbortSignal.any([leave-signal, AbortSignal.timeout]), so
 * a slow server cannot hang the lobby, and leaving cancels in-flight requests.
 */
export class Lobby {
  #ac: AbortController | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly events = new Bus<LobbyEvents>();
  readonly url: string;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly fetchImpl: (url: string, opts: FetchOptions) => Promise<unknown>;
  rooms: readonly RoomInfo[] = [];
  requests = 0; // counters for the README
  aborted = 0;

  constructor({
    url = "/api/rooms",
    intervalMs = 3000,
    timeoutMs = 2000,
    fetchImpl = fetchJson,
  }: {
    url?: string;
    intervalMs?: number;
    timeoutMs?: number;
    fetchImpl?: Lobby["fetchImpl"];
  } = {}) {
    this.url = url;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  get active(): boolean {
    return this.#ac !== null && !this.#ac.signal.aborted;
  }

  /** Start polling while the lobby is visible. */
  show(): void {
    if (this.active) return;
    this.#ac = new AbortController();
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.intervalMs);
  }

  /** Stop polling and abort whatever is in flight. */
  leave(): void {
    clearInterval(this.#timer);
    this.#ac?.abort(new DOMException("left the lobby", "AbortError"));
  }

  async refresh(): Promise<void> {
    const signal = this.#ac?.signal;
    if (!signal || signal.aborted) return;
    this.requests++;
    try {
      const data = RoomsResponse.parse(
        await this.fetchImpl(this.url, { signal, timeoutMs: this.timeoutMs }),
      );
      this.rooms = data.rooms;
      this.events.emit("rooms", { rooms: this.rooms, at: new Date() });
    } catch (err: unknown) {
      if (signal.aborted) {
        this.aborted++;
        return; // we left on purpose: not an error
      }
      this.events.emit("error", { error: err });
    }
  }

  /** POST /api/rooms; the new room appears in the next refresh. */
  async createRoom(name: string): Promise<RoomInfo> {
    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (this.#ac) signals.push(this.#ac.signal);
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.any(signals),
    });
    const body: unknown = await res.json();
    if (!res.ok) {
      const e = ErrorBody.safeParse(body);
      throw new Error(e.success ? e.data.error : `HTTP ${res.status}`);
    }
    const room = CreatedRoom.parse(body);
    await this.refresh();
    return room;
  }

  /** Fetch the room's arena config, then leave the lobby and announce the join. */
  async join(roomId: string, playerName: string): Promise<void> {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) return;
    this.events.emit("joining", { room });
    let arena = DEFAULT_ARENA;
    let warning: string | null = null;
    try {
      arena = ArenaSchema.parse(
        await loadJson(room.arena, { signal: this.#ac?.signal, timeoutMs: 3000 }),
      );
    } catch (err: unknown) {
      const why = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      warning = `Арена «${room.name}» не завантажилась (${why}) — граємо на стандартній`;
    }
    this.leave();
    this.events.emit("join", { room, arena, name: playerName || "pilot", warning });
  }
}
