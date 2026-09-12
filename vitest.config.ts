import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    restoreMocks: true,
    pool: "forks",
    maxWorkers: 1,
  },
});
