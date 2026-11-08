/**
 * WebSocket wrapper.
 *  - messages are JSON; each incoming one is re-dispatched as an event named by its `type`
 *  - send() while (re)connecting goes to a queue, flushed on "open"
 *  - unexpected close → reconnect with exponential backoff + jitter (0.5 s … 10 s);
 *    protocol errors (4000–4006) are NOT retried: reconnecting would just fail again
 * Events: "open", "close" {code, reason, willRetry, inMs}, "<type>" {…msg}
 */
const NO_RETRY = new Set([4000, 4001, 4002, 4003, 4004, 4005, 4006]);

export class Connection extends EventTarget {
  #ws = null;
  #queue = [];
  #attempt = 0;
  #timer = 0;
  #closedByUser = false;

  constructor(
    url,
    { baseMs = 500, maxMs = 10_000, maxQueue = 100, WebSocketImpl = WebSocket } = {},
  ) {
    super();
    this.url = url;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.maxQueue = maxQueue;
    this.WebSocketImpl = WebSocketImpl;
    this.reconnects = 0;
    this.bytesIn = 0; // counters for the netgraph
    this.bytesOut = 0;
  }

  get connected() {
    return this.#ws?.readyState === 1;
  }

  connect() {
    this.#closedByUser = false;
    const ws = new this.WebSocketImpl(this.url);
    ws.binaryType = "arraybuffer"; // snapshots arrive as ArrayBuffer, ready for DataView
    this.#ws = ws;
    ws.onopen = () => {
      this.#attempt = 0;
      this.dispatchEvent(new Event("open")); // listeners may send (e.g. "join") before the queue
      for (const msg of this.#queue.splice(0)) ws.send(msg);
    };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        this.bytesIn += e.data.byteLength;
        this.dispatchEvent(new CustomEvent("binary", { detail: e.data }));
        return;
      }
      this.bytesIn += e.data.length; // UTF-16 length ≈ bytes for our ASCII JSON
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        console.warn("ignoring non-JSON frame");
        return;
      }
      this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
    };
    ws.onclose = (e) => {
      if (this.#ws !== ws) return;
      const willRetry = !this.#closedByUser && !NO_RETRY.has(e.code);
      const inMs = willRetry ? this.#backoff() : 0;
      this.dispatchEvent(
        new CustomEvent("close", { detail: { code: e.code, reason: e.reason, willRetry, inMs } }),
      );
      if (willRetry) {
        this.#timer = setTimeout(() => {
          this.reconnects++;
          this.connect();
        }, inMs);
      }
    };
    ws.onerror = () => {}; // a "close" always follows; handled there
  }

  #backoff() {
    const cap = Math.min(this.maxMs, this.baseMs * 2 ** this.#attempt++);
    return cap / 2 + Math.random() * (cap / 2); // "equal jitter": never 0, never > cap
  }

  send(msg) {
    const text = JSON.stringify(msg);
    if (this.connected) {
      this.bytesOut += text.length;
      this.#ws.send(text);
    } else if (this.#queue.length < this.maxQueue) this.#queue.push(text);
  }

  /** Real-time data (inputs): sent now or never — queuing stale inputs is useless. */
  sendRaw(data) {
    if (!this.connected) return false;
    this.bytesOut += typeof data === "string" ? data.length : data.byteLength;
    this.#ws.send(data);
    return true;
  }

  close() {
    this.#closedByUser = true;
    clearTimeout(this.#timer);
    this.#ws?.close(1000, "bye");
  }
}

export function wsUrl(path = "/ws") {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
}
