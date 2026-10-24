import { defineConfig } from "vitest/config";

const recordings = Boolean(process.env.COLONIST_RECORDINGS_PATH);

export default defineConfig({
  test: {
    testTimeout: recordings ? 120000 : 5000,
    hookTimeout: recordings ? 120000 : 10000,
    maxWorkers: recordings ? 1 : undefined,
    fileParallelism: !recordings,
    isolate: !recordings
  }
});
