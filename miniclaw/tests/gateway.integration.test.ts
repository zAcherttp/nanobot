import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../src/bus/index";
import { createServer } from "../src/server/index";
import { AppConfigSchema } from "../src/config/schema";

const gatewayHarness = vi.hoisted(() => {
  class FakeLoop {
    public static instances: FakeLoop[] = [];
    public readonly start = vi.fn(async () => {});
    public readonly stop = vi.fn();

    constructor(..._args: unknown[]) {
      FakeLoop.instances.push(this);
    }
  }

  return {
    FakeLoop,
    server: {
      on: vi.fn(),
      close: vi.fn((callback?: (err?: Error) => void) => callback?.()),
    },
    serve: vi.fn(),
  };
});

gatewayHarness.serve.mockImplementation(() => gatewayHarness.server);

vi.mock("@hono/node-server", () => ({
  serve: gatewayHarness.serve,
}));

vi.mock("../src/agent/loop", () => ({
  AgentLoop: gatewayHarness.FakeLoop,
}));

describe("gateway integration", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("exposes the trimmed health and message ingestion routes through the Hono server", async () => {
    const bus = new MessageBus();
    const inbound: Array<{ content: string; channel?: string }> = [];

    bus.subscribeInbound((event) => {
      inbound.push({
        content: String(event.message.content),
        channel: event.channel,
      });
    });

    const app = createServer(bus);

    const health = await app.request("/api/health");
    const invalid = await app.request("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: 123 }),
    });
    const valid = await app.request("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello from http" }),
    });
    const removedSseRoute = await app.request("/api/sse/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello from sse" }),
    });

    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });
    expect(invalid.status).toBe(400);
    expect(valid.status).toBe(200);
    expect(removedSseRoute.status).toBe(404);
    expect(inbound).toEqual([
      { content: "hello from http", channel: undefined },
    ]);
  });

  it.each([
    "SIGINT",
    "SIGTERM",
  ] as const)("boots the gateway service, starts the agent loop, and shuts down cleanly on %s", async (signal) => {
    const { GatewayService } = await import("../src/services/gateway");
    const config = AppConfigSchema.parse({
      workspace: { path: "workspace" },
      channels: {
        cli: { enabled: false },
        telegram: { enabled: false, botToken: "", allowedUsers: [] },
      },
      dream: { enabled: false },
      memory: { enabled: false },
    });

    const configService = {
      load: vi.fn().mockResolvedValue(config),
    };

    gatewayHarness.FakeLoop.instances = [];
    gatewayHarness.serve.mockClear();
    gatewayHarness.server.close.mockClear();

    const executePromise = new GatewayService(configService as never).execute();

    await waitFor(() => gatewayHarness.serve.mock.calls.length === 1);
    process.emit(signal);
    await executePromise;

    expect(configService.load).toHaveBeenCalled();
    expect(gatewayHarness.serve).toHaveBeenCalledWith(
      expect.objectContaining({ port: config.gateway.port }),
    );
    expect(gatewayHarness.FakeLoop.instances).toHaveLength(1);
    expect(gatewayHarness.FakeLoop.instances[0].start).toHaveBeenCalled();
    expect(gatewayHarness.FakeLoop.instances[0].stop).toHaveBeenCalled();
    expect(gatewayHarness.server.close).toHaveBeenCalled();
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

  throw new Error("Timed out waiting for gateway condition");
}
