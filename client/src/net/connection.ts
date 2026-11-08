import { Bus } from "@skyduel/shared/bus.ts";
import {
  type ClientMessageIn,
  parseServerMessage,
  type ServerMessage,
  type ServerMessageOf,
} from "@skyduel/shared/protocol.ts";

/** Close codes that will fail again on reconnect (protocol errors): never retried. */
const NO_RETRY: ReadonlySet<number> = new Set([4000, 4001, 4002, 4003, 4004, 4005, 4006]);

export interface ConnectionEvents {
  open: Record<string, never>;
  close: { code: number; reason: string; willRetry: boolean; inMs: number };
  binary: { data: ArrayBuffer };
  invalid: { reason: string };
}

/** One event per server message type: "chat" carries a chat message, "roster" a roster… */
type ServerEvents = { [T in ServerMessage["type"]]: ServerMessageOf<T> };

/**
 * WebSocket wrapper.
 *  - every incoming JSON frame is validated by the shared zod schema, then
 *    dispatched to typed handlers: `conn.on("chat", (m) => m.text)`;
 *  - send() while (re)connecting goes to a queue, flushed on "open";
 *  - unexpected close → reconnect with exponential backoff + jitter (0.5 s … 10 s);
 *    protocol errors (4000–4006) are NOT retried.
 */
export class Connection {
  #ws: WebSocket | null = null;
  #queue: string[] = [];
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closedByUser = false;
  readonly #messages = new Bus<ServerEvents>();
  readonly events = new Bus<ConnectionEvents>();
  readonly url: string;
  readonly baseMs: number;
  readonly maxMs: number;
  readonly maxQueue: number;
  reconnects = 0;
  bytesIn = 0; // counters for the netgraph
  bytesOut = 0;

  constructor(url: string, { baseMs = 500, maxMs = 10_000, maxQueue = 100 } = {}) {
    this.url = url;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.maxQueue = maxQueue;
  }

  get connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /** Typed subscription to one server message type. */
  on<T extends ServerMessage["type"]>(
    type: T,
    handler: (msg: ServerMessageOf<T>) => void,
    options: { signal?: AbortSignal } = {},
  ): () => void {
    return this.#messages.on(type, handler, options);
  }

  connect(): void {
    this.#closedByUser = false;
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer"; // snapshots arrive as ArrayBuffer, ready for DataView
    this.#ws = ws;
    ws.onopen = () => {
      this.#attempt = 0;
      this.events.emit("open", {}); // listeners may send (e.g. "join") before the queue
      for (const msg of this.#queue.splice(0)) ws.send(msg);
    };
    ws.onmessage = (e: MessageEvent<unknown>) => {
      if (e.data instanceof ArrayBuffer) {
        this.bytesIn += e.data.byteLength;
        this.events.emit("binary", { data: e.data });
        return;
      }
      if (typeof e.data === "string") this.bytesIn += e.data.length;
      const parsed = parseServerMessage(e.data);
      if (!parsed.ok) {
        console.warn("invalid server message:", parsed.error.reason);
        this.events.emit("invalid", { reason: parsed.error.reason });
        return;
      }
      this.#messages.emit(parsed.value.type, parsed.value);
    };
    ws.onclose = (e) => {
      if (this.#ws !== ws) return;
      const willRetry = !this.#closedByUser && !NO_RETRY.has(e.code);
      const inMs = willRetry ? this.#backoff() : 0;
      this.events.emit("close", { code: e.code, reason: e.reason, willRetry, inMs });
      if (willRetry) {
        this.#timer = setTimeout(() => {
          this.reconnects++;
          this.connect();
        }, inMs);
      }
    };
    ws.onerror = () => {}; // a "close" always follows; handled there
  }

  #backoff(): number {
    const cap = Math.min(this.maxMs, this.baseMs * 2 ** this.#attempt++);
    return cap / 2 + Math.random() * (cap / 2); // "equal jitter": never 0, never > cap
  }

  /** Control messages: typed by the shared protocol; queued while (re)connecting. */
  send(msg: ClientMessageIn): void {
    const text = JSON.stringify(msg);
    if (this.#ws && this.connected) {
      this.bytesOut += text.length;
      this.#ws.send(text);
    } else if (this.#queue.length < this.maxQueue) this.#queue.push(text);
  }

  /** Real-time data (inputs): sent now or never — queuing stale inputs is useless. */
  sendRaw(data: ArrayBuffer | string): boolean {
    if (!this.#ws || !this.connected) return false;
    this.bytesOut += typeof data === "string" ? data.length : data.byteLength;
    this.#ws.send(data);
    return true;
  }

  close(): void {
    this.#closedByUser = true;
    clearTimeout(this.#timer);
    this.#ws?.close(1000, "bye");
  }
}

export function wsUrl(path = "/ws"): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
}
