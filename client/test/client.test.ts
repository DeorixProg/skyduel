import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { HttpError, isRetryable, withRetry } from "../src/assets/loader.ts";
import { createRecorder } from "../src/experiments.ts";
import { createInput, readControls } from "../src/input.ts";
import { Lobby } from "../src/lobby/lobby.ts";
import { createLoop } from "../src/loop.ts";
import { Connection } from "../src/net/connection.ts";
import { createNetgraph } from "../src/net/netgraph.ts";

/** A fake requestAnimationFrame driven by hand: frame(t) runs the queued callbacks. */
function fakeRaf() {
  let queue: Array<(t: number) => void> = [];
  let now = 0;
  return {
    now: () => now,
    raf: (cb: (t: number) => void) => {
      queue.push(cb);
      return queue.length;
    },
    caf: () => {
      queue = [];
    },
    frame(dtMs: number) {
      now += dtMs;
      const q = queue;
      queue = [];
      for (const cb of q) cb(now);
    },
  };
}

describe("fixed-timestep loop (fake rAF clock)", () => {
  test("60 steps per simulated second on a 144 Hz display", () => {
    const r = fakeRaf();
    let steps = 0;
    let frames = 0;
    const loop = createLoop({
      step: 1 / 60,
      simulate: () => steps++,
      render: () => frames++,
      now: r.now,
      raf: r.raf,
      caf: r.caf,
    });
    loop.start();
    for (let i = 0; i < 144; i++) r.frame(1000 / 144);
    assert.ok(steps >= 59 && steps <= 60, `steps ${steps}`);
    assert.equal(frames, 144);
  });
  test("a 500 ms hitch is clamped to 0.25 s: no spiral of death", () => {
    const r = fakeRaf();
    let steps = 0;
    const loop = createLoop({
      step: 1 / 60,
      simulate: () => steps++,
      render: () => {},
      now: r.now,
      raf: r.raf,
      caf: r.caf,
    });
    loop.start();
    r.frame(500);
    assert.equal(steps, 15); // 0.25 s × 60
  });
  test("alpha is the leftover fraction of a step", () => {
    const r = fakeRaf();
    let alpha = -1;
    const loop = createLoop({
      step: 1 / 60,
      simulate: () => {},
      render: (a) => (alpha = a),
      now: r.now,
      raf: r.raf,
      caf: r.caf,
    });
    loop.start();
    r.frame(25); // 1.5 steps
    assert.ok(Math.abs(alpha - 0.5) < 1e-9);
    loop.stop();
    r.frame(16);
    assert.ok(Math.abs(alpha - 0.5) < 1e-9); // stopped: no more frames
  });
  test("interval mode uses the injected timer functions", () => {
    vi.useFakeTimers();
    let frames = 0;
    const loop = createLoop({
      simulate: () => {},
      render: () => frames++,
      mode: "interval",
      now: () => Date.now(),
      setInterval: (cb, ms) => Number(setInterval(cb, ms)),
      clearInterval: (id) => clearInterval(id),
    });
    loop.start();
    vi.advanceTimersByTime(160);
    loop.stop();
    vi.useRealTimers();
    assert.equal(frames, 10);
  });
});

describe("input", () => {
  test("justPressed lasts exactly until endStep(); blur releases keys", () => {
    const input = createInput(window);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    assert.equal(input.justPressed("Space"), true);
    input.endStep();
    assert.equal(input.justPressed("Space"), false);
    assert.equal(input.isDown("Space"), true);
    window.dispatchEvent(new Event("blur"));
    assert.equal(input.isDown("Space"), false);
    input.dispose();
  });
  test("readControls maps keys to Controls", () => {
    const input = createInput(window);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA" }));
    assert.deepEqual(readControls(input), { thrust: true, turn: -1, fire: false });
    input.dispose();
  });
});

describe("retry policy", () => {
  test("5xx, timeouts and network errors are retried; 4xx and bad JSON are not", () => {
    assert.equal(isRetryable(new HttpError("/x", 503)), true);
    assert.equal(isRetryable(new HttpError("/x", 404)), false);
    assert.equal(isRetryable(new DOMException("t", "TimeoutError")), true);
    assert.equal(isRetryable(new TypeError("network")), true);
    assert.equal(isRetryable(new SyntaxError("json")), false);
  });
  test("withRetry stops after the first success and after a non-retryable error", async () => {
    let calls = 0;
    const v = await withRetry(
      async () => (++calls < 3 ? Promise.reject(new HttpError("/x", 500)) : "ok"),
      { baseMs: 1 },
    );
    assert.equal(v, "ok");
    assert.equal(calls, 3);
    calls = 0;
    await assert.rejects(
      withRetry(async () => (++calls, Promise.reject(new HttpError("/x", 400))), { baseMs: 1 }),
    );
    assert.equal(calls, 1);
  });
});

/** Minimal WebSocket stand-in for the Connection tests. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static OPEN = 1;
  readyState = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  close() {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

describe("Connection", () => {
  const real = globalThis.WebSocket;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.stubGlobal("WebSocket", real);
  });

  test("queues while connecting, flushes on open, validates incoming messages", () => {
    const c = new Connection("ws://x/ws");
    c.connect();
    c.send({ type: "chat", text: "hi" });
    const ws = FakeSocket.last;
    assert.ok(ws);
    assert.equal(ws.sent.length, 0);
    ws.open();
    assert.equal(ws.sent.length, 1);
    const chats: string[] = [];
    c.on("chat", (m) => chats.push(m.text));
    ws.onmessage?.({
      data: JSON.stringify({ type: "chat", from: 1, name: "a", text: "yo", t: 1 }),
    });
    ws.onmessage?.({ data: JSON.stringify({ type: "chat", text: 42 }) }); // invalid: dropped
    assert.deepEqual(chats, ["yo"]);
  });

  test("reconnects with growing backoff, but not after a protocol error", () => {
    const c = new Connection("ws://x/ws", { baseMs: 100, maxMs: 1000 });
    const delays: number[] = [];
    c.events.on("close", (e) => delays.push(e.inMs));
    c.connect();
    for (let i = 0; i < 4; i++) {
      FakeSocket.last?.onclose?.({ code: 1006, reason: "" });
      vi.advanceTimersByTime(2000);
    }
    assert.equal(c.reconnects, 4);
    assert.ok(
      delays.every((d, i) => d >= (100 * 2 ** i) / 2 && d <= Math.min(1000, 100 * 2 ** i)),
      delays.join(),
    );
    FakeSocket.last?.onclose?.({ code: 4001, reason: "unknown type" });
    vi.advanceTimersByTime(5000);
    assert.equal(c.reconnects, 4);
  });
});

describe("Lobby", () => {
  test("polls while visible, stops and aborts on leave", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const lobby = new Lobby({
      intervalMs: 1000,
      fetchImpl: async () => {
        calls++;
        return { rooms: [{ id: "a", name: "A", players: 0, maxPlayers: 4, arena: "/a.json" }] };
      },
    });
    let seen = 0;
    lobby.events.on("rooms", () => seen++);
    lobby.show();
    await vi.advanceTimersByTimeAsync(3100);
    lobby.leave();
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    assert.equal(calls, 4); // immediately + 3 intervals, then nothing
    assert.equal(seen, 4);
    assert.equal(lobby.active, false);
  });
  test("a malformed rooms response is an error event, not a crash", async () => {
    const lobby = new Lobby({ fetchImpl: async () => ({ rooms: "nope" }) });
    const errors: unknown[] = [];
    lobby.events.on("error", (e) => errors.push(e.error));
    lobby.show();
    await new Promise((r) => setTimeout(r, 10));
    lobby.leave();
    assert.equal(errors.length, 1);
  });
});

describe("measurement helpers", () => {
  test("recorder keeps a ring and computes percentiles", () => {
    const r = createRecorder(4);
    for (const t of [0, 10, 20, 30, 40, 50]) r.mark(t);
    assert.equal(r.frames.length, 4);
    assert.equal(r.summary().p50, 10);
  });
  test("netgraph rolls per-second counters", () => {
    const g = createNetgraph();
    g.onSnapshot(500);
    g.onCorrection(0.3);
    g.onRtt(120);
    assert.equal(g.state.lastSnapshotBytes, 500);
    assert.equal(g.state.corrections.length, 1);
    assert.equal(g.state.rtt, 120);
  });
});
