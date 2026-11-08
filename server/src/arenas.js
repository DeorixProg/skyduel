import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK = { name: "default", seed: 22, balloons: 6, hunters: 1 };

/**
 * The server needs the same arena config the client loads: read it from the
 * built client (STATIC_DIR) or, in development, from client/public.
 */
export function loadArena(urlPath, staticDir) {
  const rel = urlPath.replace(/^\/+/, "");
  if (!/^assets\/arenas\/[\w-]+\.json$/.test(rel)) return FALLBACK;
  for (const root of [staticDir, path.join(here, "..", "..", "client", "public")]) {
    try {
      return { ...FALLBACK, ...JSON.parse(readFileSync(path.join(root, rel), "utf8")) };
    } catch {
      // try the next root
    }
  }
  return FALLBACK;
}
