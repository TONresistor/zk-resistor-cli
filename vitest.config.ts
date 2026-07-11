import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use `forks` pool: each test file gets its own child process. Threads
    // pool (default) shares stdio with the parent in a way that swallows
    // spawnSync/execa output of grandchild processes — breaks CLI smoke tests.
    pool: "forks",
  },
});
