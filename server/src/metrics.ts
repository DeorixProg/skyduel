import { performance } from "node:perf_hooks";
import { Counter, collectDefaultMetrics, Gauge, Registry } from "prom-client";
import type { RoomManager } from "./rooms.ts";
import type { Stats } from "./stats.ts";

/**
 * Prometheus metrics at /metrics. Counters are monotonic (rates are computed
 * by the scraper, e.g. rate(skyduel_messages_in_total[1m])); for humans and
 * the README the same values are also exposed as per-second gauges over the
 * window since the previous scrape.
 */
export function createMetrics({ rooms, stats }: { rooms: RoomManager; stats: Stats }) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "skyduel_" }); // rss, heap, GC, event-loop lag

  const rejections = new Counter({
    name: "skyduel_rejections_total",
    help: "Connections or messages refused, by reason",
    labelNames: ["reason"] as const,
    registers: [registry],
  });

  let last = {
    t: performance.now(),
    msgIn: 0,
    bytesIn: 0,
    bytesOut: 0,
    elu: performance.eventLoopUtilization(),
  };
  const window = () => {
    const t = performance.now();
    const dt = Math.max(0.001, (t - last.t) / 1000);
    const elu = performance.eventLoopUtilization();
    const out = {
      msgInPerSec: (stats.messagesIn - last.msgIn) / dt,
      bytesInPerSec: (stats.bytesIn - last.bytesIn) / dt,
      bytesOutPerSec: (stats.bytesOut - last.bytesOut) / dt,
      elu: performance.eventLoopUtilization(elu, last.elu).utilization,
    };
    last = { t, msgIn: stats.messagesIn, bytesIn: stats.bytesIn, bytesOut: stats.bytesOut, elu };
    return out;
  };
  let current = window();

  const gauge = (name: string, help: string, read: () => number) =>
    new Gauge({
      name,
      help,
      registers: [registry],
      collect() {
        this.set(read());
      },
    });
  const tickP99 = () => Math.max(0, ...[...rooms].map((r) => r.match?.stats().tickMsP99 ?? 0));

  gauge("skyduel_players", "Players in rooms (sockets + bots)", () =>
    [...rooms].reduce((n, r) => n + r.players.size, 0),
  );
  gauge("skyduel_rooms", "Open rooms", () => rooms.size);
  gauge(
    "skyduel_connections",
    "Open WebSocket connections",
    () => stats.connections - stats.disconnections,
  );
  gauge(
    "skyduel_messages_in_per_second",
    "Messages received per second (since last scrape)",
    () => {
      current = window(); // the first gauge collected refreshes the window for the others
      return current.msgInPerSec;
    },
  );
  gauge("skyduel_bytes_in_per_second", "Bytes received per second", () => current.bytesInPerSec);
  gauge("skyduel_bytes_out_per_second", "Bytes sent per second", () => current.bytesOutPerSec);
  gauge(
    "skyduel_event_loop_utilization",
    "Event-loop utilisation 0..1 (since last scrape)",
    () => current.elu,
  );
  gauge(
    "skyduel_tick_ms_p99",
    "Worst room's simulation tick time, p99 over the last 300 ticks",
    tickP99,
  );
  for (const [name, read] of [
    ["skyduel_messages_in_total", () => stats.messagesIn],
    ["skyduel_bytes_in_total", () => stats.bytesIn],
    ["skyduel_bytes_out_total", () => stats.bytesOut],
  ] as const) {
    gauge(name, `${name} (monotonic)`, read);
  }

  return {
    registry,
    reject(reason: string): void {
      rejections.inc({ reason });
    },
    /** Same numbers as JSON, for the README and humans. */
    snapshot() {
      return { ...window(), tickMsP99: tickP99() };
    },
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
