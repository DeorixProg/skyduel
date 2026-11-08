import { z } from "zod";

/** Arena config: loaded by the client (lobby) and by the server (Match). One schema for both. */
export const ArenaSchema = z.object({
  name: z.string().default("Тренувальне небо"),
  seed: z.number().int().default(22),
  balloons: z.number().int().min(0).max(50).default(6),
  hunters: z.number().int().min(0).max(50).default(1),
  sky: z.tuple([z.string(), z.string()]).default(["#5b9bd5", "#a9d2f0"]),
});
export type ArenaConfig = z.output<typeof ArenaSchema>;
export const DEFAULT_ARENA: ArenaConfig = Object.freeze(ArenaSchema.parse({}));
