import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environmentMatchGlobs: [["test/widget/**", "jsdom"], ["test/embed/**", "jsdom"]],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
