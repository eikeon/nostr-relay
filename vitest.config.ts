import { defineConfig } from "vitest/config"
import { resolve } from "node:path"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globals: false,
    setupFiles: ["./vitest.setup.ts"]
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src")
    }
  }
})
