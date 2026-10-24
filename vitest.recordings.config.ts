import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    isolate: false,
    testTimeout: 120000,
    hookTimeout: 120000
  }
});
