import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include:       ["test/**/*.test.ts"],
    testTimeout:   20000,   // E2E: Neovim startup + socket negotiation
    hookTimeout:   10000,
    globals:          false,
    // Each test file spawns its own Neovim process + mock server.
    // Run files sequentially to avoid cross-file socket discovery collisions.
    fileParallelism:  false,
    sequence:         { concurrent: false },
    reporters: ["verbose"],
  },
});
