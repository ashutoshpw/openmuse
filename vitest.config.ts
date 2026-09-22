import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/**/*.test.{ts,tsx}",
      "apps/**/*.spec.{ts,tsx}",
      "packages/**/*.test.{ts,tsx}",
      "packages/**/*.spec.{ts,tsx}"
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/.expo/**",
      "**/coverage/**",
      "**/ios/**",
      "**/android/**",
      "apps/mobile/**",
      "**/e2e/**",
      "**/*.native.test.*",
      "**/*.native.spec.*"
    ],
    passWithNoTests: true
  }
});
