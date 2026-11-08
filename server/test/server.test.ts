import assert from "node:assert/strict";
import { once } from "node:events";
import { createWriteStream, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CLOSE, parseClientMessage } from "@skyduel/shared/protocol.ts";
import { entityId, playerId } from "@skyduel/shared/types.ts";
import { afterAll as after, beforeAll as before, describe, test } from "vitest";
import { WebSocket } from "ws";
import { type App, createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { toNdjson } from "../src/log/matchlog.ts";
import { readEvents } from "../src/log/replay.ts";
import { createLogger } from "../src/logger.ts";
import { createTokenBucket } from "../src/ratelimit.ts";
import { RoomManager, type RoomPlayer } from "../src/rooms.ts";
import { TestClient } from "./helpers.ts";

const errorCode = (raw: string): number | null => {
  const r = parseClientMessage(Buffer.from(raw));
  return r.ok ? null : r.error.code;
};

describe("protocol (zod)", () => {
  test("accepts a valid join and fills the codec default", () => {
    const r = parseClientMessage(Buffer.from('{"type":"join","room":"somme","name":" Max "}'));
    assert.ok(r.ok);
    assert.deepEqual(r.value, { type: "join", room: "somme", name: "Max", codec: "binary" });
  });
  test("bad JSON → 4000", () => assert.equal(errorCode("{oops"), CLOSE.BAD_JSON));
  test("unknown type → 4001", () =>
    assert.equal(errorCode('{"type":"teleport"}'), CLOSE.UNKNOWN_TYPE));
  test("prototype keys are not message types", () =>
    assert.equal(errorCode('{"type":"constructor"}'), CLOSE.UNKNOWN_TYPE));
  test("wrong shape → 4002", () => {
    assert.equal(errorCode('{"type":"chat","text":""}'), CLOSE.BAD_SHAPE);
    assert.equal(errorCode('{"type":"join","room":"../x","name":"a"}'), CLOSE.BAD_SHAPE);
    assert.equal(errorCode("[1,2]"), CLOSE.BAD_SHAPE);
  });
  test("non-text input never throws", () => {
    for (const v of [undefined, null, 42, {}, new Uint8Array([0xff, 0xfe])]) {
      assert.equal(parseClientMessage(v).ok, false);
    }
  });
});

describe("token bucket", () => {
  test("allows a burst, then refills at the rate", () => {
    let t = 0;
    const b = createTokenBucket({ rate: 10, burst: 5, now: () => t });
    for (let i = 0; i < 5; i++) assert.equal(b.take(), true);
    assert.equal(b.take(), false);
    t += 100; // +1 token
    assert.equal(b.take(), true);
    assert.equal(b.take(), false);
  });
});

/** A socket that never connects (port 1 refuses); rooms only store it. */
function deadSocket(): WebSocket {
  const ws = new WebSocket("ws://127.0.0.1:1");
  ws.on("error", () => {}); // an unhandled "error" would crash the test process (see Lab 4)
  return ws;
}

const fakePlayer = (id: number, name: string): RoomPlayer => ({
  id: playerId(id),
  name,
  ws: deadSocket(),
  shipId: entityId(id),
  color: "#000",
});

describe("rooms", () => {
  const arena = "/assets/arenas/somme.json";
  test("non-persistent room is deleted when it becomes empty", () => {
    const rm = new RoomManager({ maxRooms: 5, maxPlayersPerRoom: 4 });
    const room = rm.create({ id: "tmp", name: "tmp", arena });
    room.join(fakePlayer(1, "a"));
    room.leave(playerId(1));
    assert.equal(rm.get("tmp"), undefined);
  });
  test("persistent room survives being empty; caps are enforced", () => {
    const rm = new RoomManager({ maxRooms: 1, maxPlayersPerRoom: 1 });
    const room = rm.create({ id: "p", name: "p", persistent: true, arena });
    room.join(fakePlayer(1, "a"));
    assert.throws(() => room.join(fakePlayer(2, "b")), /full/);
    room.leave(playerId(1));
    assert.ok(rm.get("p"));
    assert.throws(() => rm.create({ id: "q", name: "q", arena }), /limit/);
  });
});

describe("match log stream", () => {
  test("toNdjson turns objects into lines and readEvents reads them back", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "skyduel-")), "t.ndjson");
    const events = [
      { t: 1, type: "join" },
      { t: 2, type: "chat", text: "привіт" },
    ];
    await pipeline(Readable.from(events), toNdjson(), createWriteStream(file));
    assert.equal(
      readFileSync(file, "utf8"),
      '{"t":1,"type":"join"}\n{"t":2,"type":"chat","text":"привіт"}\n',
    );
    const back: unknown[] = [];
    for await (const e of readEvents(file)) back.push(e);
    assert.deepEqual(back, events);
  });
});

describe("config (zod)", () => {
  test("rejects invalid values with a clear message", () => {
    assert.throws(() => loadConfig({ PORT: "abc" }), /PORT/);
    assert.throws(() => loadConfig({ MAX_PLAYERS_PER_ROOM: "5000" }), /MAX_PLAYERS_PER_ROOM/);
    assert.equal(loadConfig({ PORT: "9000" }).port, 9000);
    assert.equal(loadConfig({ PORT: "" }).port, 8080); // empty = not set
  });
});

describe("heartbeat", () => {
  test("a client that never answers pings is terminated after two missed pongs", async () => {
    const config = loadConfig({
      LOG_DIR: mkdtempSync(path.join(os.tmpdir(), "skyduel-hb-")),
      HEARTBEAT_MS: "100",
    });
    const app = createApp({ config, logger: createLogger({ level: "silent" }) });
    const { port } = await app.listen(0, "127.0.0.1");
    const c = await TestClient.connect(`ws://127.0.0.1:${port}/ws`, { autoPong: false });
    c.send({ type: "join", room: "somme", name: "Ghost" });
    const t = Date.now();
    assert.equal(await c.closed(), 1006); // terminate(): no close frame
    assert.ok(Date.now() - t >= 200 && Date.now() - t < 1000);
    await app.close();
  });
});

describe("server (integration)", () => {
  let app: App;
  let base = "";
  let logDir = "";
  before(async () => {
    logDir = mkdtempSync(path.join(os.tmpdir(), "skyduel-logs-"));
    const config = loadConfig({
      HOST: "127.0.0.1",
      LOG_DIR: logDir,
      JOIN_TIMEOUT_MS: "300",
      MSG_RATE: "5",
      MSG_BURST: "10",
    });
    app = createApp({ config, logger: createLogger({ level: "silent" }) });
    const addr = await app.listen(0, "127.0.0.1");
    base = `127.0.0.1:${addr.port}`;
  });
  after(() => app.close());
  const connect = () => TestClient.connect(`ws://${base}/ws`);

  test("GET /health and /api/rooms", async () => {
    const h: unknown = await (await fetch(`http://${base}/health`)).json();
    assert.ok(h && typeof h === "object" && "status" in h && h.status === "ok");
    const r: unknown = await (await fetch(`http://${base}/api/rooms`)).json();
    assert.ok(r && typeof r === "object" && "rooms" in r && Array.isArray(r.rooms));
    assert.deepEqual(
      r.rooms.map((x: { id: string }) => x.id),
      ["somme", "verdun", "night"],
    );
  });

  test("POST /api/rooms validates and creates", async () => {
    const post = (body: string) => fetch(`http://${base}/api/rooms`, { method: "POST", body });
    assert.equal((await post("{nope")).status, 400);
    assert.equal((await post(JSON.stringify({ name: "x".repeat(5000) }))).status, 413);
    assert.equal((await post(JSON.stringify({ name: "Bad", maxPlayers: 99 }))).status, 400);
    const ok = await post(JSON.stringify({ name: "Test Room", maxPlayers: 2 }));
    assert.equal(ok.status, 201);
    assert.deepEqual(await ok.json(), {
      id: "test-room",
      name: "Test Room",
      players: 0,
      maxPlayers: 2,
      arena: "/assets/arenas/somme.json",
    });
  });

  test("path traversal is rejected (raw socket, so nothing normalises the path)", async () => {
    for (const p of [
      "/../server/src/config.ts",
      "/%2e%2e/%2e%2e/package.json",
      "/assets/..%2f..%2fpackage.json",
    ]) {
      const sock = net.connect(Number(base.split(":")[1]), "127.0.0.1");
      await once(sock, "connect");
      sock.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      let text = "";
      for await (const chunk of sock) text += String(chunk);
      assert.match(text, /^HTTP\/1.1 400/, p);
    }
  });

  test("two clients: join, roster, chat", async () => {
    const a = await connect();
    const b = await connect();
    a.send({ type: "join", room: "somme", name: "Alice" });
    await a.waitFor("welcome");
    b.send({ type: "join", room: "somme", name: "Bob" });
    await a.waitFor("roster", (m) => m.players.length === 2);
    b.send({ type: "chat", text: "hello" });
    const chat = await a.waitFor("chat");
    assert.equal(chat.name, "Bob");
    assert.equal(chat.text, "hello");
    b.ws.close();
    await a.waitFor("roster", (m) => m.players.length === 1);
    a.ws.close();
  });

  test("bad JSON closes with 4000, unknown type with 4001", async () => {
    const a = await connect();
    a.send("{not json");
    assert.equal(await a.closed(), CLOSE.BAD_JSON);
    const b = await connect();
    b.send({ type: "nuke" });
    assert.equal(await b.closed(), CLOSE.UNKNOWN_TYPE);
  });

  test("no join within the timeout → 4003", async () => {
    const a = await connect();
    assert.equal(await a.closed(), CLOSE.JOIN_TIMEOUT);
  });

  test("message flood → 4008", async () => {
    const a = await connect();
    a.send({ type: "join", room: "night", name: "Spammer" });
    for (let i = 0; i < 50; i++) a.send({ type: "chat", text: `spam ${i}` });
    assert.equal(await a.closed(), CLOSE.RATE_LIMIT);
  });

  test("oversize frame → 1009 from ws maxPayload", async () => {
    const a = await connect();
    a.send({ type: "chat", text: "x".repeat(10_000) });
    assert.equal(await a.closed(), CLOSE.TOO_BIG);
  });

  test("graceful close flushes match logs and tells clients", async () => {
    const a = await connect();
    a.send({ type: "join", room: "verdun", name: "Last" });
    await a.waitFor("welcome");
    a.send({ type: "chat", text: "до побачення" });
    await a.waitFor("chat");
    const closed = a.closed();
    await app.close();
    assert.ok(a.inbox.some((m) => m.type === "shutdown"));
    assert.equal(await closed, CLOSE.GOING_AWAY);
    const file = readdirSync(logDir).find((f) => f.startsWith("verdun-"));
    assert.ok(file);
    const types = readFileSync(path.join(logDir, file), "utf8")
      .trim()
      .split("\n")
      .map((l): unknown => JSON.parse(l))
      .map((e) => (e && typeof e === "object" && "type" in e ? e.type : null));
    assert.deepEqual(types, ["join", "chat", "leave", "close"]);
  });
});

describe("bots", () => {
  test("a room with only bots left is deleted", async () => {
    const config = loadConfig({
      LOG_DIR: mkdtempSync(path.join(os.tmpdir(), "skyduel-bots-")),
      MAX_PLAYERS_PER_ROOM: "16",
    });
    const app = createApp({ config, logger: createLogger({ level: "silent" }) });
    const { port } = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const room: unknown = await (
      await fetch(`${base}/api/rooms`, {
        method: "POST",
        body: JSON.stringify({ name: "Bots", maxPlayers: 8 }),
      })
    ).json();
    assert.ok(room && typeof room === "object" && "id" in room && room.id === "bots");
    const human = await TestClient.connect(`ws://127.0.0.1:${port}/ws`);
    human.send({ type: "join", room: "bots", name: "Human" });
    await human.waitFor("welcome");
    const res = await fetch(`${base}/api/rooms/bots/bots`, {
      method: "POST",
      body: JSON.stringify({ count: 3 }),
    });
    assert.equal(res.status, 201);
    await human.waitFor("roster", (m) => m.players.length === 4);
    human.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(app.rooms.get("bots"), undefined);
    await app.close();
  });
});
