import { execFileSync } from "node:child_process";

/**
 * Build version: GIT_SHA is baked in at `docker build --build-arg GIT_SHA=…`
 * (from the tag's commit in CI). Outside Docker, ask git; failing that, "dev".
 */
function detect(): string {
  const fromEnv = process.env.GIT_SHA;
  if (fromEnv) return fromEnv.slice(0, 12);
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "dev";
  }
}

export const VERSION = Object.freeze({
  sha: detect(),
  tag: process.env.GIT_TAG ?? null,
  startedAt: new Date().toISOString(),
});
