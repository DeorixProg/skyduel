import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { toNdjson } from "../src/log/matchlog.js";
import { readEvents } from "../src/log/replay.js";
import { createLogger } from "../src/logger.js";
import { CLOSE, parseMessage } from "../src/protocol.js";
import { createTokenBucket } from "../src/ratelimit.js";
import { RoomManager } from "../src/rooms.js";

describe("protocol", () => {
  test("accepts a valid join", () => {
    const r = parseMessage(Buffer.from('{"type":"join","room":"somme","name":"Max"}'));
    assert.equal(r.ok, true);
  });
  test("bad JSON → 4000", () =>
    assert.equal(parseMessage(Buffer.from("{oops")).code, CLOSE.BAD_JSON));
  test("unknown type → 4001", () =>
    assert.equal(parseMessage(Buffer.from('{"type":"teleport"}')).code, CLOSE.UNKNOWN_TYPE));
  test("prototype keys are not message types", () =>
    assert.equal(parseMessage(Buffer.from('{"type":"constructor"}')).code, CLOSE.UNKNOWN_TYPE));
  test("wrong shape → 4002", () => {
    assert.equal(parseMessage(Buffer.from('{"type":"chat","text":""}')).code, CLOSE.BAD_SHAPE);
    assert.equal(
      parseMessage(Buffer.from('{"type":"join","room":"../x","name":"a"}')).code,
      CLOSE.BAD_SHAPE,
    );
    assert.equal(parseMessage(Buffer.from("[1,2]")).code, CLOSE.BAD_SHAPE);
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

describe("rooms", () => {
  test("non-persistent room is deleted when it becomes empty", () => {
    const rm = new RoomManager({ maxRooms: 5, maxPlayersPerRoom: 4 });
    const room = rm.create({ id: "tmp", name: "tmp" });
    room.join({ id: 1, name: "a" });
    room.leave(1);
    assert.equal(rm.get("tmp"), undefined);
  });
  test("persistent room survives being empty; caps are enforced", () => {
    const rm = new RoomManager({ maxRooms: 1, maxPlayersPerRoom: 1 });
    const room = rm.create({ id: "p", name: "p", persistent: true });
    room.join({ id: 1, name: "a" });
    assert.throws(() => room.join({ id: 2, name: "b" }), /full/);
    room.leave(1);
    assert.ok(rm.get("p"));
    assert.throws(() => rm.create({ id: "q", name: "q" }), /limit/);
  });
});

describe("match log stream", () => {
  test("toNdjson turns objects into lines and readEvents reads them back", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "skyduel-"));
    const file = path.join(dir, "t.ndjson");
    const { createWriteStream } = await import("node:fs");
    const { pipeline } = await import("node:stream/promises");
    const events = [
      { t: 1, type: "join" },
      { t: 2, type: "chat", text: "привіт" },
    ];
    await pipeline(Readable.from(events), toNdjson(), createWriteStream(file));
    assert.equal(
      readFileSync(file, "utf8"),
      '{"t":1,"type":"join"}\n{"t":2,"type":"chat","text":"привіт"}\n',
    );
    const back = [];
    for await (const e of readEvents(file)) back.push(e);
    assert.deepEqual(back, events);
  });
});

describe("config", () => {
  test("rejects invalid values with a clear message", () => {
    assert.throws(() => loadConfig({ PORT: "abc" }), /PORT must be an integer/);
    assert.equal(loadConfig({ PORT: "9000" }).port, 9000);
  });
});

describe("heartbeat", () => {
  test("a client that never answers pings is terminated after two missed pongs", async () => {
    const logDir = mkdtempSync(path.join(os.tmpdir(), "skyduel-hb-"));
    const config = loadConfig({ LOG_DIR: logDir, HEARTBEAT_MS: "100" });
    const app = createApp({ config, logger: createLogger({ level: "silent" }) });
    const { port } = await app.listen(0, "127.0.0.1");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { autoPong: false });
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "join", room: "somme", name: "Ghost" }));
    const t = Date.now();
    const [code] = await once(ws, "close");
    assert.equal(code, 1006); // terminate(): no close frame
    assert.ok(Date.now() - t >= 200 && Date.now() - t < 1000);
    await app.close();
  });
});

describe("server (integration)", () => {
  let app;
  let base;
  let logDir;
  before(async () => {
    logDir = mkdtempSync(path.join(os.tmpdir(), "skyduel-logs-"));
    const config = loadConfig({
      PORT: "0",
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

  const connect = async () => {
    const ws = new WebSocket(`ws://${base}/ws`);
    ws.inbox = [];
    ws.on("message", (d) => ws.inbox.push(JSON.parse(d.toString())));
    await once(ws, "open");
    return ws;
  };
  const waitFor = async (ws, pred, ms = 2000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const m = ws.inbox.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timeout waiting for message");
  };

  test("GET /health and /api/rooms", async () => {
    const h = await (await fetch(`http://${base}/health`)).json();
    assert.equal(h.status, "ok");
    const r = await (await fetch(`http://${base}/api/rooms`)).json();
    assert.deepEqual(
      r.rooms.map((x) => x.id),
      ["somme", "verdun", "night"],
    );
  });

  test("POST /api/rooms validates and creates", async () => {
    const bad = await fetch(`http://${base}/api/rooms`, { method: "POST", body: "{nope" });
    assert.equal(bad.status, 400);
    const big = await fetch(`http://${base}/api/rooms`, {
      method: "POST",
      body: JSON.stringify({ name: "x".repeat(5000) }),
    });
    assert.equal(big.status, 413);
    const ok = await fetch(`http://${base}/api/rooms`, {
      method: "POST",
      body: JSON.stringify({ name: "Test Room", maxPlayers: 2 }),
    });
    assert.equal(ok.status, 201);
    assert.equal((await ok.json()).id, "test-room");
  });

  test("path traversal is rejected (raw socket, so nothing normalises the path)", async () => {
    for (const p of [
      "/../server/src/config.js",
      "/%2e%2e/%2e%2e/package.json",
      "/assets/..%2f..%2fpackage.json",
    ]) {
      const sock = net.connect(Number(base.split(":")[1]), "127.0.0.1");
      await once(sock, "connect");
      sock.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      let text = "";
      for await (const chunk of sock) text += chunk;
      assert.match(text, /^HTTP\/1.1 400/, p);
    }
  });

  test("two clients: join, roster, chat", async () => {
    const a = await connect();
    const b = await connect();
    a.send(JSON.stringify({ type: "join", room: "somme", name: "Alice" }));
    await waitFor(a, (m) => m.type === "welcome");
    b.send(JSON.stringify({ type: "join", room: "somme", name: "Bob" }));
    await waitFor(a, (m) => m.type === "roster" && m.players.length === 2);
    b.send(JSON.stringify({ type: "chat", text: "hello" }));
    const chat = await waitFor(a, (m) => m.type === "chat");
    assert.equal(chat.name, "Bob");
    assert.equal(chat.text, "hello");
    b.close();
    await waitFor(a, (m) => m.type === "roster" && m.players.length === 1);
    a.close();
  });

  test("bad JSON closes with 4000, unknown type with 4001", async () => {
    const a = await connect();
    a.send("{not json");
    const [code] = await once(a, "close");
    assert.equal(code, CLOSE.BAD_JSON);
    const b = await connect();
    b.send(JSON.stringify({ type: "nuke" }));
    assert.equal((await once(b, "close"))[0], CLOSE.UNKNOWN_TYPE);
  });

  test("no join within the timeout → 4003", async () => {
    const a = await connect();
    assert.equal((await once(a, "close"))[0], CLOSE.JOIN_TIMEOUT);
  });

  test("message flood → 4008", async () => {
    const a = await connect();
    a.send(JSON.stringify({ type: "join", room: "night", name: "Spammer" }));
    for (let i = 0; i < 50; i++) a.send(JSON.stringify({ type: "chat", text: `spam ${i}` }));
    assert.equal((await once(a, "close"))[0], CLOSE.RATE_LIMIT);
  });

  test("oversize frame → 1009 from ws maxPayload", async () => {
    const a = await connect();
    a.send(JSON.stringify({ type: "chat", text: "x".repeat(10_000) }));
    assert.equal((await once(a, "close"))[0], CLOSE.TOO_BIG);
  });

  test("graceful close flushes match logs and tells clients", async () => {
    const a = await connect();
    a.send(JSON.stringify({ type: "join", room: "verdun", name: "Last" }));
    await waitFor(a, (m) => m.type === "welcome");
    a.send(JSON.stringify({ type: "chat", text: "до побачення" }));
    await waitFor(a, (m) => m.type === "chat");
    const closed = once(a, "close");
    await app.close();
    assert.ok(a.inbox.some((m) => m.type === "shutdown"));
    assert.equal((await closed)[0], CLOSE.GOING_AWAY);
    const file = readdirSync(logDir).find((f) => f.startsWith("verdun-"));
    const lines = readFileSync(path.join(logDir, file), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.map((e) => e.type),
      ["join", "chat", "leave", "close"],
    );
  });
});
