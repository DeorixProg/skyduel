import { EventEmitter } from "node:events";
import type { RoomInfo } from "@skyduel/shared/protocol.ts";
import type { EntityId, PlayerId } from "@skyduel/shared/types.ts";
import type { WebSocket } from "ws";
import type { Match } from "./match.ts";

export interface RoomPlayer {
  readonly id: PlayerId;
  readonly name: string;
  readonly ws: WebSocket;
  readonly shipId: EntityId;
  readonly color: string;
}

/** One line of the match log. */
export type MatchEvent =
  | { t: number; room: string; type: "join"; player: PlayerId; name: string }
  | { t: number; room: string; type: "leave"; player: PlayerId; reason: string }
  | { t: number; room: string; type: "chat"; player: PlayerId; text: string }
  | { t: number; room: string; type: "close" };

/** Typed events: `room.on("chat", (p, text) => …)` knows p is a RoomPlayer and text a string. */
export interface RoomEvents {
  join: [player: RoomPlayer];
  leave: [player: RoomPlayer, reason: string];
  chat: [player: RoomPlayer, text: string];
  empty: [];
  event: [event: MatchEvent];
  close: [];
  error: [err: Error];
}

export interface RoomOptions {
  id: string;
  name: string;
  maxPlayers: number;
  arena: string;
  persistent?: boolean;
}

export class Room extends EventEmitter<RoomEvents> {
  readonly id: string;
  readonly name: string;
  readonly maxPlayers: number;
  readonly arena: string;
  readonly persistent: boolean;
  readonly players = new Map<PlayerId, RoomPlayer>();
  readonly createdAt = Date.now();
  closed = false;
  match: Match | null = null; // attached by ws.ts

  constructor({ id, name, maxPlayers, arena, persistent = false }: RoomOptions) {
    super();
    this.id = id;
    this.name = name;
    this.maxPlayers = maxPlayers;
    this.arena = arena;
    this.persistent = persistent;
  }

  get full(): boolean {
    return this.players.size >= this.maxPlayers;
  }

  join(player: RoomPlayer): void {
    if (this.closed) throw new Error(`room ${this.id} is closed`);
    if (this.full) throw new Error(`room ${this.id} is full`);
    this.players.set(player.id, player);
    this.emit("event", {
      t: Date.now(),
      room: this.id,
      type: "join",
      player: player.id,
      name: player.name,
    });
    this.emit("join", player);
  }

  leave(playerId: PlayerId, reason = "left"): void {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);
    this.emit("event", { t: Date.now(), room: this.id, type: "leave", player: playerId, reason });
    this.emit("leave", player, reason);
    if (this.players.size === 0) this.emit("empty");
  }

  chat(playerId: PlayerId, text: string): void {
    const player = this.players.get(playerId);
    if (!player) return;
    this.emit("event", { t: Date.now(), room: this.id, type: "chat", player: playerId, text });
    this.emit("chat", player, text);
  }

  roster(): Array<{ id: PlayerId; name: string; shipId: EntityId; color: string }> {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      shipId: p.shipId,
      color: p.color,
    }));
  }

  toJSON(): RoomInfo {
    return {
      id: this.id,
      name: this.name,
      players: this.players.size,
      maxPlayers: this.maxPlayers,
      arena: this.arena,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("event", { t: Date.now(), room: this.id, type: "close" });
    this.emit("close");
    this.removeAllListeners();
  }
}

interface ManagerEvents {
  created: [room: Room];
  deleted: [room: Room];
  "room-error": [room: Room, err: Error];
}

/** Owns all rooms; deletes a non-persistent room when its "empty" event fires. */
export class RoomManager extends EventEmitter<ManagerEvents> {
  readonly #rooms = new Map<string, Room>();
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;

  constructor({ maxRooms, maxPlayersPerRoom }: { maxRooms: number; maxPlayersPerRoom: number }) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
  }

  create({
    id,
    name,
    maxPlayers = this.maxPlayersPerRoom,
    arena,
    persistent = false,
  }: Omit<RoomOptions, "maxPlayers"> & { maxPlayers?: number }): Room {
    if (this.#rooms.size >= this.maxRooms) throw new RangeError("room limit reached");
    if (this.#rooms.has(id)) throw new RangeError(`room ${id} already exists`);
    const room = new Room({
      id,
      name,
      maxPlayers: Math.min(maxPlayers, this.maxPlayersPerRoom),
      arena,
      persistent,
    });
    // An EventEmitter "error" with no listener throws and kills the whole process — so there is always one.
    room.on("error", (err) => this.emit("room-error", room, err));
    room.on("empty", () => {
      if (!room.persistent) this.delete(id);
    });
    this.#rooms.set(id, room);
    this.emit("created", room);
    return room;
  }

  get(id: string): Room | undefined {
    return this.#rooms.get(id);
  }

  delete(id: string): void {
    const room = this.#rooms.get(id);
    if (!room) return;
    this.#rooms.delete(id);
    room.close();
    this.emit("deleted", room);
  }

  list(): RoomInfo[] {
    return [...this.#rooms.values()].map((r) => r.toJSON());
  }

  get size(): number {
    return this.#rooms.size;
  }

  [Symbol.iterator](): IterableIterator<Room> {
    return this.#rooms.values();
  }

  closeAll(): void {
    for (const id of [...this.#rooms.keys()]) this.delete(id);
  }
}
