import { defineConfig } from "vitest/config";

/** The kicad_tools gates (`pnpm test:gates`): slow, need a kicad_tools build. */
export default defineConfig({
  test: { environment: "node", include: ["test/gates/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 60_000 },
});
