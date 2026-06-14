import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // background.ts is a singleton with module-level side effects (onMessage registration).
    // singleThread ensures the captured handler array is shared across all tests in one run.
    singleThread: true,
  },
});
