import { defineConfig } from "vitest/config";

/** Unit tests; the kicad_tools gates run separately (`pnpm test:gates`). */
export default defineConfig({ test: { environment: "node", include: ["test/*.test.ts"] } });
