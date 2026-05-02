import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalRunConfig, EvalScenario } from "../src/eval/types";

const runnerHarness = vi.hoisted(() => ({
  ctorArgs: [] as EvalRunConfig[],
  runAll: vi.fn(async () => ({ ok: "all" })),
  runOne: vi.fn(async (scenarioId: string) => ({ ok: scenarioId })),
}));

const scenarioHarness = vi.hoisted(() => ({
  loadEvalScenarios: vi.fn<[], Promise<EvalScenario[]>>(),
}));

vi.mock("../src/eval/runner", () => ({
  EvalRunner: class FakeEvalRunner {
    constructor(config: EvalRunConfig) {
      runnerHarness.ctorArgs.push(config);
    }

    async runAll() {
      return runnerHarness.runAll();
    }

    async runOne(scenarioId: string) {
      return runnerHarness.runOne(scenarioId);
    }
  },
}));

vi.mock("../src/eval/scenario", () => ({
  loadEvalScenarios: (...args: []) =>
    scenarioHarness.loadEvalScenarios(...args),
}));

describe("EvalService", () => {
  const configService = {
    load: vi.fn(async () => ({
      workspace: { path: "/workspace" },
      thread: {
        provider: "openai",
        modelId: "gpt-test",
        apiKeys: {
          openai: "",
          anthropic: "",
          ollama: "",
          nvidia: "",
        },
        store: { path: "/threads" },
      },
      tools: {
        exec: {
          enable: true,
          timeout: 60,
          pathAppend: "",
          sandbox: "",
          allowedEnvKeys: [],
        },
        restrictToWorkspace: false,
      },
      eval: {
        defaultMode: "simulate",
        outputDir: "/reports",
        throttle: {
          llmMaxConcurrency: 1,
          gwsMaxConcurrency: 1,
          llmCooldownMs: 0,
          gwsCooldownMs: 250,
          turnCooldownMs: 100,
          maxToolCallsPerScenario: 20,
        },
        timeouts: {
          scenarioMs: 120000,
          turnMs: 30000,
        },
        safeWindow: {
          start: "2026-06-01T00:00:00.000Z",
          end: "2026-06-30T23:59:59.000Z",
        },
        eventPrefix: "[MINICLAW-EVAL]",
      },
    })),
  };

  const scenarios: EvalScenario[] = [
    {
      id: "simulate-one",
      title: "Sim one",
      mode: "simulate",
      complexity: "simple",
      turns: ["hello"],
      assertions: {},
      rubricWeights: {
        recallRelevance: 1,
        planningCoherence: 1,
        consentPolicyAdherence: 1,
        proposalUsefulness: 1,
        efficiency: 1,
      },
    },
    {
      id: "live-one",
      title: "Live one",
      mode: "sandbox-live",
      complexity: "moderate",
      turns: ["hello"],
      assertions: {},
      rubricWeights: {
        recallRelevance: 1,
        planningCoherence: 1,
        consentPolicyAdherence: 1,
        proposalUsefulness: 1,
        efficiency: 1,
      },
    },
  ];

  beforeEach(() => {
    runnerHarness.ctorArgs = [];
    runnerHarness.runAll.mockClear();
    runnerHarness.runOne.mockClear();
    scenarioHarness.loadEvalScenarios.mockReset();
    scenarioHarness.loadEvalScenarios.mockResolvedValue(scenarios);
    configService.load.mockClear();
  });

  it("filters runAll scenarios to the requested mode", async () => {
    const { EvalService } = await import("../src/services/eval");
    const service = new EvalService(configService as never);

    await service.runAll({ mode: "sandbox-live" });

    expect(runnerHarness.ctorArgs).toHaveLength(1);
    expect(runnerHarness.ctorArgs[0].mode).toBe("sandbox-live");
    expect(runnerHarness.ctorArgs[0].keepWorkspace).toBe(false);
    expect(
      runnerHarness.ctorArgs[0].scenarios.map((entry) => entry.id),
    ).toEqual(["live-one"]);
  });

  it("passes keepWorkspace through to the runner config", async () => {
    const { EvalService } = await import("../src/services/eval");
    const service = new EvalService(configService as never);

    await service.runAll({ mode: "sandbox-live", keepWorkspace: true });

    expect(runnerHarness.ctorArgs).toHaveLength(1);
    expect(runnerHarness.ctorArgs[0].keepWorkspace).toBe(true);
  });

  it("passes only the requested scenario to runOne when the mode matches", async () => {
    const { EvalService } = await import("../src/services/eval");
    const service = new EvalService(configService as never);

    await service.runOne("simulate-one", { mode: "simulate" });

    expect(runnerHarness.ctorArgs).toHaveLength(1);
    expect(
      runnerHarness.ctorArgs[0].scenarios.map((entry) => entry.id),
    ).toEqual(["simulate-one"]);
    expect(runnerHarness.runOne).toHaveBeenCalledWith("simulate-one");
  });

  it("rejects runOne when the requested mode does not match the scenario", async () => {
    const { EvalService } = await import("../src/services/eval");
    const service = new EvalService(configService as never);

    await expect(
      service.runOne("simulate-one", { mode: "sandbox-live" }),
    ).rejects.toThrow(
      'Eval scenario "simulate-one" is authored for simulate, not sandbox-live.',
    );
  });
});
