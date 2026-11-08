import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ArenaConfig, ArenaSchema, DEFAULT_ARENA } from "@skyduel/shared/arena-config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK: ArenaConfig = DEFAULT_ARENA;

/**
 * The server needs the same arena config the client loads: read it from the
 * built client (STATIC_DIR) or, in development, from client/public.
 */
export function loadArena(urlPath: string, staticDir: string): ArenaConfig {
  const rel = urlPath.replace(/^\/+/, "");
  if (!/^assets\/arenas\/[\w-]+\.json$/.test(rel)) return FALLBACK;
  for (const root of [staticDir, path.join(here, "..", "..", "client", "public")]) {
    try {
      const parsed = ArenaSchema.safeParse(JSON.parse(readFileSync(path.join(root, rel), "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // missing or corrupt: try the next root
    }
  }
  return FALLBACK;
}

export type { ArenaConfig };
