import { defineConfig } from "vitest/config";

/** One `npm test` for all three packages; coverage is measured on shared/ (the simulation). */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "shared",
          root: "shared",
          environment: "node",
          include: ["test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "server",
          root: "server",
          environment: "node",
          include: ["test/**/*.test.ts"],
          testTimeout: 15000,
        },
      },
      {
        test: {
          name: "client",
          root: "client",
          environment: "happy-dom",
          include: ["test/**/*.test.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["shared/src/**/*.ts", "src/**/*.ts"],
      exclude: ["**/env.d.ts", "**/determinism.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { lines: 85, statements: 85 },
    },
  },
});
