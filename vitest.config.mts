import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src"), "server-only": path.resolve(import.meta.dirname, "tests/server-only-stub.ts") } },
  test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 30000, fileParallelism: false, env: { NODE_ENV: "test" } },
});
