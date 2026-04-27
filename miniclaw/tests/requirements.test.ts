import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  RequirementsChecker,
  Requirements,
  RequirementCheckResult,
} from "../src/utils/requirements";

// Mock child_process
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

describe("RequirementsChecker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("checkBinary", () => {
    it("should return true when binary exists on Unix", async () => {
      const { exec } = vi.mocked(await import("node:child_process"));
      exec.mockImplementation((command, callback) => {
        callback(null, { stdout: "/usr/bin/node\n", stderr: "" });
      });

      const result = await RequirementsChecker.checkBinary("node");

      expect(result).toBe(true);
    });

    it("should return true when binary exists on Windows", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });

      const { exec } = vi.mocked(await import("node:child_process"));
      exec.mockImplementation((command, callback) => {
        callback(null, {
          stdout: "C:\\Program Files\\nodejs\\node.exe\n",
          stderr: "",
        });
      });

      const result = await RequirementsChecker.checkBinary("node");

      expect(result).toBe(true);

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("should return false when binary does not exist", async () => {
      const { exec } = vi.mocked(await import("node:child_process"));
      exec.mockImplementation((command, callback) => {
        callback(new Error("command not found"), null);
      });

      const result =
        await RequirementsChecker.checkBinary("nonexistent-binary");

      expect(result).toBe(false);
    });

    it("should handle multiple binary checks", async () => {
      const { exec } = vi.mocked(await import("node:child_process"));
      exec
        .mockImplementationOnce((command, callback) => {
          callback(null, { stdout: "/usr/bin/node\n", stderr: "" });
        })
        .mockImplementationOnce((command, callback) => {
          callback(null, { stdout: "/usr/bin/npm\n", stderr: "" });
        })
        .mockImplementationOnce((command, callback) => {
          callback(new Error("command not found"), null);
        });

      const nodeResult = await RequirementsChecker.checkBinary("node");
      const npmResult = await RequirementsChecker.checkBinary("npm");
      const nonexistentResult =
        await RequirementsChecker.checkBinary("nonexistent");

      expect(nodeResult).toBe(true);
      expect(npmResult).toBe(true);
      expect(nonexistentResult).toBe(false);
    });
  });

  describe("checkEnvVar", () => {
    it("should return true when environment variable is set", () => {
      process.env.TEST_VAR = "test-value";

      const result = RequirementsChecker.checkEnvVar("TEST_VAR");

      expect(result).toBe(true);

      delete process.env.TEST_VAR;
    });

    it("should return false when environment variable is not set", () => {
      delete process.env.NONEXISTENT_VAR;

      const result = RequirementsChecker.checkEnvVar("NONEXISTENT_VAR");

      expect(result).toBe(false);
    });

    it("should return false when environment variable is empty string", () => {
      process.env.EMPTY_VAR = "";

      const result = RequirementsChecker.checkEnvVar("EMPTY_VAR");

      expect(result).toBe(false);

      delete process.env.EMPTY_VAR;
    });

    it("should handle environment variable with whitespace", () => {
      process.env.WHITESPACE_VAR = "   ";

      const result = RequirementsChecker.checkEnvVar("WHITESPACE_VAR");

      expect(result).toBe(true);

      delete process.env.WHITESPACE_VAR;
    });

    it("should handle environment variable with special characters", () => {
      process.env.SPECIAL_VAR = "test@#$%^&*()";

      const result = RequirementsChecker.checkEnvVar("SPECIAL_VAR");

      expect(result).toBe(true);

      delete process.env.SPECIAL_VAR;
    });
  });

  describe("checkRequirements", () => {
    it("should return satisfied when all requirements are met", async () => {
      vi.mocked(await import("node:child_process")).exec.mockImplementation(
        (command, callback) => {
          callback(null, { stdout: "/usr/bin/node\n", stderr: "" });
        },
      );
      process.env.API_KEY = "secret";

      const requirements: Requirements = {
        bins: ["node"],
        env: ["API_KEY"],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.satisfied).toBe(true);
      expect(result.missingBins).toEqual([]);
      expect(result.missingEnv).toEqual([]);

      delete process.env.API_KEY;
    });

    it("should return unsatisfied when binary is missing", async () => {
      vi.mocked(await import("node:child_process")).exec.mockImplementation(
        (command, callback) => {
          callback(new Error("command not found"), null);
        },
      );

      const requirements: Requirements = {
        bins: ["nonexistent"],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.satisfied).toBe(false);
      expect(result.missingBins).toEqual(["nonexistent"]);
      expect(result.missingEnv).toEqual([]);
    });

    it("should return unsatisfied when environment variable is missing", async () => {
      delete process.env.MISSING_VAR;

      const requirements: Requirements = {
        env: ["MISSING_VAR"],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.satisfied).toBe(false);
      expect(result.missingBins).toEqual([]);
      expect(result.missingEnv).toEqual(["MISSING_VAR"]);
    });

    it("should return unsatisfied when both binary and env var are missing", async () => {
      vi.mocked(await import("node:child_process")).exec.mockImplementation(
        (command, callback) => {
          callback(new Error("command not found"), null);
        },
      );
      delete process.env.MISSING_VAR;

      const requirements: Requirements = {
        bins: ["nonexistent"],
        env: ["MISSING_VAR"],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.satisfied).toBe(false);
      expect(result.missingBins).toEqual(["nonexistent"]);
      expect(result.missingEnv).toEqual(["MISSING_VAR"]);
    });

    it("should handle multiple missing binaries", async () => {
      const { exec } = vi.mocked(await import("node:child_process"));
      exec
        .mockImplementationOnce((command, callback) => {
          callback(new Error("not found"), null);
        })
        .mockImplementationOnce((command, callback) => {
          callback(new Error("not found"), null);
        });

      const requirements: Requirements = {
        bins: ["binary1", "binary2"],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.satisfied).toBe(false);
      expect(result.missingBins).toEqual(["binary1", "binary2"]);
    });

    it("should handle multiple missing environment variables", async () => {
      delete process.env.VAR1;
      delete process.env.VAR2;

      const requirements: Requirements = {
        env: ["VAR1", "VAR2"],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.satisfied).toBe(false);
      expect(result.missingEnv).toEqual(["VAR1", "VAR2"]);
    });

    it("should handle partial satisfaction", async () => {
      const { exec } = vi.mocked(await import("node:child_process"));
      exec
        .mockImplementationOnce((command, callback) => {
          callback(null, { stdout: "/usr/bin/node\n", stderr: "" });
        })
        .mockImplementationOnce((command, callback) => {
          callback(new Error("not found"), null);
        });
      process.env.API_KEY = "secret";
      delete process.env.MISSING_VAR;

      const requirements: Requirements = {
        bins: ["node", "nonexistent"],
        env: ["API_KEY", "MISSING_VAR"],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.satisfied).toBe(false);
      expect(result.missingBins).toEqual(["nonexistent"]);
      expect(result.missingEnv).toEqual(["MISSING_VAR"]);

      delete process.env.API_KEY;
    });

    it("should handle empty requirements", async () => {
      const requirements: Requirements = {};

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.satisfied).toBe(true);
      expect(result.missingBins).toEqual([]);
      expect(result.missingEnv).toEqual([]);
    });

    it("should handle only binary requirements", async () => {
      vi.mocked(await import("node:child_process")).exec.mockImplementation(
        (command, callback) => {
          callback(null, { stdout: "/usr/bin/node\n", stderr: "" });
        },
      );

      const requirements: Requirements = {
        bins: ["node"],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.satisfied).toBe(true);
      expect(result.missingBins).toEqual([]);
      expect(result.missingEnv).toEqual([]);
    });

    it("should handle only environment variable requirements", async () => {
      process.env.API_KEY = "secret";

      const requirements: Requirements = {
        env: ["API_KEY"],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.satisfied).toBe(true);
      expect(result.missingBins).toEqual([]);
      expect(result.missingEnv).toEqual([]);

      delete process.env.API_KEY;
    });
  });

  describe("getMissingRequirements", () => {
    it("should return empty array when all requirements met", async () => {
      vi.mocked(await import("node:child_process")).exec.mockImplementation(
        (command, callback) => {
          callback(null, { stdout: "/usr/bin/node\n", stderr: "" });
        },
      );
      process.env.API_KEY = "secret";

      const requirements: Requirements = {
        bins: ["node"],
        env: ["API_KEY"],
      };

      const missing =
        await RequirementsChecker.getMissingRequirements(requirements);

      expect(missing).toEqual([]);

      delete process.env.API_KEY;
    });

    it("should return descriptions of missing binaries", async () => {
      vi.mocked(await import("node:child_process")).exec.mockImplementation(
        (command, callback) => {
          callback(new Error("not found"), null);
        },
      );

      const requirements: Requirements = {
        bins: ["node", "npm"],
      };

      const missing =
        await RequirementsChecker.getMissingRequirements(requirements);

      expect(missing).toHaveLength(2);
      expect(missing[0]).toContain("Binary 'node'");
      expect(missing[1]).toContain("Binary 'npm'");
    });

    it("should return descriptions of missing environment variables", async () => {
      delete process.env.API_KEY;
      delete process.env.SECRET;

      const requirements: Requirements = {
        env: ["API_KEY", "SECRET"],
      };

      const missing =
        await RequirementsChecker.getMissingRequirements(requirements);

      expect(missing).toHaveLength(2);
      expect(missing[0]).toContain("Environment variable 'API_KEY'");
      expect(missing[1]).toContain("Environment variable 'SECRET'");
    });

    it("should return descriptions of both missing types", async () => {
      vi.mocked(await import("node:child_process")).exec.mockImplementation(
        (command, callback) => {
          callback(new Error("not found"), null);
        },
      );
      delete process.env.API_KEY;

      const requirements: Requirements = {
        bins: ["node"],
        env: ["API_KEY"],
      };

      const missing =
        await RequirementsChecker.getMissingRequirements(requirements);

      expect(missing).toHaveLength(2);
      expect(missing[0]).toContain("Binary 'node'");
      expect(missing[1]).toContain("Environment variable 'API_KEY'");
    });
  });

  describe("formatResult", () => {
    it("should format satisfied result", () => {
      const result: RequirementCheckResult = {
        satisfied: true,
        missingBins: [],
        missingEnv: [],
      };

      const formatted = RequirementsChecker.formatResult(result);

      expect(formatted).toBe("All requirements are satisfied.");
    });

    it("should format unsatisfied result with missing binaries", () => {
      const result: RequirementCheckResult = {
        satisfied: false,
        missingBins: ["node", "npm"],
        missingEnv: [],
      };

      const formatted = RequirementsChecker.formatResult(result);

      expect(formatted).toContain("Missing requirements:");
      expect(formatted).toContain("Binaries: node, npm");
    });

    it("should format unsatisfied result with missing environment variables", () => {
      const result: RequirementCheckResult = {
        satisfied: false,
        missingBins: [],
        missingEnv: ["API_KEY", "SECRET"],
      };

      const formatted = RequirementsChecker.formatResult(result);

      expect(formatted).toContain("Missing requirements:");
      expect(formatted).toContain("Environment variables: API_KEY, SECRET");
    });

    it("should format unsatisfied result with both missing types", () => {
      const result: RequirementCheckResult = {
        satisfied: false,
        missingBins: ["node"],
        missingEnv: ["API_KEY"],
      };

      const formatted = RequirementsChecker.formatResult(result);

      expect(formatted).toContain("Missing requirements:");
      expect(formatted).toContain("Binaries: node");
      expect(formatted).toContain("Environment variables: API_KEY");
    });
  });

  describe("real-world scenarios", () => {
    it("should check calendar provider requirements", async () => {
      vi.mocked(await import("node:child_process")).exec.mockImplementation(
        (command, callback) => {
          callback(null, { stdout: "/usr/bin/gws\n", stderr: "" });
        },
      );
      process.env.GWS_API_KEY = "test-key";

      const requirements: Requirements = {
        bins: ["gws"],
        env: ["GWS_API_KEY"],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.satisfied).toBe(true);

      delete process.env.GWS_API_KEY;
    });

    it("should check Lark calendar requirements", async () => {
      process.env.LARK_APP_ID = "app-id";
      process.env.LARK_APP_SECRET = "app-secret";

      const requirements: Requirements = {
        env: ["LARK_APP_ID", "LARK_APP_SECRET"],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.satisfied).toBe(true);

      delete process.env.LARK_APP_ID;
      delete process.env.LARK_APP_SECRET;
    });

    it("should check database requirements", async () => {
      vi.mocked(await import("node:child_process")).exec.mockImplementation(
        (command, callback) => {
          callback(null, { stdout: "/usr/bin/psql\n", stderr: "" });
        },
      );
      process.env.DATABASE_URL = "postgresql://localhost";

      const requirements: Requirements = {
        bins: ["psql"],
        env: ["DATABASE_URL"],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.satisfied).toBe(true);

      delete process.env.DATABASE_URL;
    });

    it("should provide helpful error message for missing requirements", async () => {
      vi.mocked(await import("node:child_process")).exec.mockImplementation(
        (command, callback) => {
          callback(new Error("not found"), null);
        },
      );
      delete process.env.API_KEY;

      const requirements: Requirements = {
        bins: ["gws"],
        env: ["GWS_API_KEY"],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);
      const formatted = RequirementsChecker.formatResult(result);

      expect(formatted).toContain("Missing requirements:");
      expect(formatted).toContain("Binaries: gws");
      expect(formatted).toContain("Environment variables: GWS_API_KEY");
    });
  });

  describe("edge cases", () => {
    it("should handle binary name with spaces", async () => {
      vi.mocked(await import("node:child_process")).exec.mockImplementation(
        (command, callback) => {
          callback(null, { stdout: "/usr/bin/test binary\n", stderr: "" });
        },
      );

      const result = await RequirementsChecker.checkBinary("test binary");

      expect(result).toBe(true);
    });

    it("should handle environment variable with special characters", () => {
      process.env["TEST-VAR"] = "value";

      const result = RequirementsChecker.checkEnvVar("TEST-VAR");

      expect(result).toBe(true);

      delete process.env["TEST-VAR"];
    });

    it("should handle empty binary list", async () => {
      const requirements: Requirements = {
        bins: [],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.satisfied).toBe(true);
    });

    it("should handle empty environment variable list", async () => {
      const requirements: Requirements = {
        env: [],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.satisfied).toBe(true);
    });

    it("should handle duplicate binary names", async () => {
      vi.mocked(await import("node:child_process")).exec.mockImplementation(
        (command, callback) => {
          callback(new Error("not found"), null);
        },
      );

      const requirements: Requirements = {
        bins: ["node", "node"],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.missingBins).toEqual(["node", "node"]);
    });

    it("should handle duplicate environment variable names", async () => {
      delete process.env.API_KEY;

      const requirements: Requirements = {
        env: ["API_KEY", "API_KEY"],
      };

      const result = await RequirementsChecker.checkRequirements(requirements);

      expect(result.missingEnv).toEqual(["API_KEY", "API_KEY"]);
    });
  });
});
