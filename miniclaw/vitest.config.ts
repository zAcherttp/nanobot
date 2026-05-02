import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/agent/loop.ts",
        "src/services/persistence.ts",
        "src/services/tasks.ts",
        "src/services/user_profile.ts",
        "src/services/task_progress.ts",
        "src/services/gateway.ts",
        "src/gateway/runtime.ts",
        "src/server/index.ts",
        "src/server/routes.ts",
        "src/channels/telegram.ts",
        "src/tools/skills.ts",
        "src/tools/tasks.ts",
        "src/tools/user_profile.ts",
      ],
      thresholds: {
        perFile: true,
        lines: 30,
        functions: 30,
        statements: 30,
        branches: 20,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
