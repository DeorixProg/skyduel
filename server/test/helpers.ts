import { once } from "node:events";
import { parseServerMessage, type ServerMessage } from "@skyduel/shared/protocol.ts";
import { WebSocket } from "ws";

/** A test client that collects every (validated) JSON message it receives. */
export class TestClient {
  readonly ws: WebSocket;
  readonly inbox: ServerMessage[] = [];

  constructor(url: string, options?: ConstructorParameters<typeof WebSocket>[2]) {
    this.ws = new WebSocket(url, options);
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const parsed = parseServerMessage(Array.isArray(data) ? Buffer.concat(data) : data);
      if (parsed.ok) this.inbox.push(parsed.value);
    });
  }

  static async connect(
    url: string,
    options?: ConstructorParameters<typeof WebSocket>[2],
  ): Promise<TestClient> {
    const c = new TestClient(url, options);
    await once(c.ws, "open");
    return c;
  }

  send(msg: unknown): void {
    this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  async closed(): Promise<number> {
    const [code] = await once(this.ws, "close");
    return Number(code);
  }

  /** Wait for the first message of a given type that matches the predicate. */
  async waitFor<T extends ServerMessage["type"]>(
    type: T,
    pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    ms = 2000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      for (const m of this.inbox) {
        if (isType(m, type) && pred(m)) return m;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for ${type}`);
  }
}

function isType<T extends ServerMessage["type"]>(
  m: ServerMessage,
  type: T,
): m is Extract<ServerMessage, { type: T }> {
  return m.type === type;
}
