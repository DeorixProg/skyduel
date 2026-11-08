import type { LocalGame } from "./game.ts";
import type { Lobby } from "./lobby/lobby.ts";
import type { Connection } from "./net/connection.ts";
import type { NetGame } from "./net/netgame.ts";

/** Debug handles used by the measurement scripts (Playwright reads them). */
declare global {
  /** Git SHA of the build, injected by vite.config.ts. */
  const __APP_VERSION__: string;
  interface Window {
    __game?: LocalGame | NetGame;
    __lobby?: Lobby;
    __conn?: Connection;
    __roomView?: { unmount(): void };
    __load?: { ms: number; mode: "sequential" | "concurrent" };
  }
}
