import { EventEmitter } from "node:events";

/**
 * A room is an EventEmitter. Events:
 *   "join"  (player)            "leave" (player, reason)
 *   "chat"  (player, text)      "empty" ()
 *   "event" ({ t, type, ... })  — one normalised stream for the match log
 *   "close" ()                  — the room is gone; listeners should detach
 */
export class Room extends EventEmitter {
  constructor({ id, name, maxPlayers, arena, persistent = false }) {
    super();
    this.id = id;
    this.name = name;
    this.maxPlayers = maxPlayers;
    this.arena = arena;
    this.persistent = persistent;
    this.players = new Map(); // playerId -> { id, name, send }
    this.createdAt = Date.now();
    this.closed = false;
  }

  get full() {
    return this.players.size >= this.maxPlayers;
  }

  #record(type, data) {
    this.emit("event", { t: Date.now(), room: this.id, type, ...data });
  }

  join(player) {
    if (this.closed) throw new Error(`room ${this.id} is closed`);
    if (this.full) throw new Error(`room ${this.id} is full`);
    this.players.set(player.id, player);
    this.#record("join", { player: player.id, name: player.name });
    this.emit("join", player);
  }

  leave(playerId, reason = "left") {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);
    this.#record("leave", { player: playerId, reason });
    this.emit("leave", player, reason);
    if (this.players.size === 0) this.emit("empty");
  }

  chat(playerId, text) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.#record("chat", { player: playerId, text });
    this.emit("chat", player, text);
  }

  roster() {
    return [...this.players.values()].map((p) => ({ id: p.id, name: p.name }));
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      players: this.players.size,
      maxPlayers: this.maxPlayers,
      arena: this.arena,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.#record("close", {});
    this.emit("close");
    this.removeAllListeners();
  }
}

/** Owns all rooms; deletes a non-persistent room when its "empty" event fires. */
export class RoomManager extends EventEmitter {
  #rooms = new Map();

  constructor({ maxRooms, maxPlayersPerRoom }) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
  }

  create({ id, name, maxPlayers = this.maxPlayersPerRoom, arena, persistent = false }) {
    if (this.#rooms.size >= this.maxRooms) throw new RangeError("room limit reached");
    if (this.#rooms.has(id)) throw new RangeError(`room ${id} already exists`);
    const room = new Room({
      id,
      name,
      maxPlayers: Math.min(maxPlayers, this.maxPlayersPerRoom),
      arena,
      persistent,
    });
    // A room never emits "error" today, but an EventEmitter "error" with no
    // listener throws and kills the whole process — so there is always one.
    room.on("error", (err) => this.emit("room-error", room, err));
    room.on("empty", () => {
      if (!room.persistent) this.delete(id);
    });
    this.#rooms.set(id, room);
    this.emit("created", room);
    return room;
  }

  get(id) {
    return this.#rooms.get(id);
  }

  delete(id) {
    const room = this.#rooms.get(id);
    if (!room) return;
    this.#rooms.delete(id);
    room.close();
    this.emit("deleted", room);
  }

  list() {
    return [...this.#rooms.values()].map((r) => r.toJSON());
  }

  get size() {
    return this.#rooms.size;
  }

  closeAll() {
    for (const id of [...this.#rooms.keys()]) this.delete(id);
  }
}
