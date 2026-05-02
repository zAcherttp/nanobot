import { afterEach, describe, expect, it, vi } from "vitest";
import { AppConfigSchema } from "../src/config/schema";

const cliHarness = vi.hoisted(() => {
  class FakeLoop {
    public static instances: FakeLoop[] = [];
    public readonly start = vi.fn(async () => {});
    public readonly stop = vi.fn(async () => {});

    constructor(..._args: unknown[]) {
      FakeLoop.instances.push(this);
    }
  }

  class FakeCliChannel {
    public static instances: FakeCliChannel[] = [];
    public readonly name = "cli";
    public readonly start = vi.fn(async () => {});
    public readonly stop = vi.fn(async () => {});
    public readonly handleOutbound = vi.fn(async () => {});

    constructor(..._args: unknown[]) {
      FakeCliChannel.instances.push(this);
    }
  }

  return { FakeLoop, FakeCliChannel };
});

vi.mock("../src/agent/loop", () => ({
  AgentLoop: cliHarness.FakeLoop,
}));

vi.mock("../src/channels/cli", () => ({
  CliChannel: cliHarness.FakeCliChannel,
}));

describe("cli agent integration", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it.each([
    "SIGINT",
    "SIGTERM",
  ] as const)("starts the CLI agent loop and shuts it down cleanly on %s", async (signal) => {
    const { CliAgentService } = await import("../src/services/cli_agent");
    const config = AppConfigSchema.parse({
      workspace: { path: "workspace" },
      channels: {
        cli: { enabled: true },
        telegram: { enabled: false, botToken: "", allowedUsers: [] },
      },
      dream: { enabled: false },
      memory: { enabled: false },
    });

    const configService = {
      load: vi.fn().mockResolvedValue(config),
    };

    cliHarness.FakeLoop.instances = [];
    cliHarness.FakeCliChannel.instances = [];

    const executePromise = new CliAgentService(
      configService as never,
    ).execute();

    await waitFor(
      () =>
        cliHarness.FakeLoop.instances.length === 1 &&
        cliHarness.FakeCliChannel.instances.length === 1,
    );

    process.emit(signal);
    await executePromise;

    expect(configService.load).toHaveBeenCalled();
    expect(cliHarness.FakeLoop.instances).toHaveLength(1);
    expect(cliHarness.FakeCliChannel.instances).toHaveLength(1);
    expect(cliHarness.FakeLoop.instances[0].start).toHaveBeenCalled();
    expect(cliHarness.FakeLoop.instances[0].stop).toHaveBeenCalled();
    expect(cliHarness.FakeCliChannel.instances[0].start).toHaveBeenCalled();
    expect(cliHarness.FakeCliChannel.instances[0].stop).toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for CLI agent condition");
}
