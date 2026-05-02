import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "@/services/config";
import { promises as fs } from "node:fs";
import { ConfigLoadError, ConfigValidationError } from "@/errors/base";

vi.mock("node:fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

describe("ConfigService", () => {
  let configService: ConfigService;

  beforeEach(() => {
    vi.resetAllMocks();
    configService = new ConfigService("miniclaw");
  });

  it("should load default config when file is missing and not explicitly provided", async () => {
    const error: any = new Error("ENOENT");
    error.code = "ENOENT";
    vi.mocked(fs.readFile).mockRejectedValueOnce(error);

    const config = await configService.load();
    expect(config.gateway.port).toBe(18790);
    expect(config.thread.provider).toBe("ollama");
    expect(Object.keys(config.channels).sort()).toEqual(["cli", "telegram"]);
  });

  it("should throw ConfigLoadError when explicitly provided file is missing", async () => {
    const error: any = new Error("ENOENT");
    error.code = "ENOENT";
    vi.mocked(fs.readFile).mockRejectedValueOnce(error);

    await expect(
      configService.load({ configPath: "custom.json" }),
    ).rejects.toThrow(ConfigLoadError);
  });

  it("should throw ConfigLoadError on invalid JSON", async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce("{ invalid json }");

    await expect(configService.load()).rejects.toThrow(ConfigLoadError);
  });

  it("should throw ConfigValidationError on invalid schema types", async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ gateway: { port: "string-port" } }),
    );

    await expect(configService.load()).rejects.toThrow(ConfigValidationError);
  });

  it("should reject legacy SSE channel config", async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({
        channels: {
          sse: { enabled: true },
        },
      }),
    );

    await expect(configService.load()).rejects.toThrow(ConfigValidationError);
  });

  it("should override with valid environment variables", async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce("{}");

    const config = await configService.load({
      envOverrides: {
        NANOBOT_GATEWAY_PORT: "8080",
        NANOBOT_LOG_LEVEL: "debug",
      },
    });

    expect(config.gateway.port).toBe(8080);
    expect(config.logging.level).toBe("debug");
  });

  it("should ignore invalid log level environment variable and use default", async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce("{}");

    const config = await configService.load({
      envOverrides: {
        NANOBOT_LOG_LEVEL: "not-a-real-level",
      },
    });

    expect(config.logging.level).toBe("info");
  });
});
