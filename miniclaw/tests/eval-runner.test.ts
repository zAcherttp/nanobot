import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppConfigSchema } from "../src/config/schema";
import { EvalRunner } from "../src/eval/runner";

const execMock = vi.hoisted(() => vi.fn());

const agentHarness = vi.hoisted(() => {
  type Listener = (event: unknown) => void | Promise<void>;

  class FakeAgent {
    public static continueImpl: ((agent: FakeAgent) => Promise<void>) | null =
      null;
    public readonly options: any;
    public readonly listeners: Listener[] = [];
    public state: { messages: any[] };

    constructor(options: any) {
      this.options = options;
      this.state = {
        messages: [...(options.initialState.messages || [])],
      };
    }

    subscribe(listener: Listener) {
      this.listeners.push(listener);
    }

    async continue() {
      if (FakeAgent.continueImpl) {
        await FakeAgent.continueImpl(this);
      }
    }

    async waitForIdle() {}
  }

  return { FakeAgent };
});

vi.mock("node:child_process", () => ({
  exec: execMock,
}));

vi.mock("@mariozechner/pi-agent-core", () => ({
  Agent: agentHarness.FakeAgent,
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn(() => ({
    id: "fake-model",
    name: "fake-model",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 512,
  })),
  registerBuiltInApiProviders: vi.fn(),
}));

describe.sequential("EvalRunner", () => {
  let tempDir: string;
  let outputDir: string;
  let config: ReturnType<typeof AppConfigSchema.parse>;
  let originalFetch: typeof global.fetch | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "miniclaw-eval-runner-"));
    outputDir = path.join(tempDir, "reports");
    originalFetch = global.fetch;
    execMock.mockReset();
    config = AppConfigSchema.parse({
      workspace: { path: path.join(tempDir, "workspace") },
      dream: { enabled: false },
      memory: { enabled: true, maxMemories: 1000 },
      thread: {
        provider: "openai",
        modelId: "gpt-test",
        contextWindowTokens: 4096,
        maxTokens: 512,
      },
      eval: {
        outputDir,
        defaultMode: "simulate",
      },
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    global.fetch = originalFetch as typeof global.fetch;
    vi.clearAllMocks();
  });

  it("runs a simulate scenario through the real agent loop path and writes reports", async () => {
    agentHarness.FakeAgent.continueImpl = async (agent) => {
      const userText = String(
        agent.state.messages.at(-1)?.content ||
          agent.options.initialState.messages.at(-1)?.content ||
          "",
      );

      if (userText.includes("morning meetings")) {
        const recordPreference = agent.options.initialState.tools.find(
          (tool: any) => tool.name === "record_user_preference",
        );
        await recordPreference.execute("tool-1", {
          preference: "Prefers morning meetings when possible.",
        });
        agent.state.messages = [
          ...agent.state.messages,
          {
            role: "assistant",
            content: [
              { type: "text", text: "Noted your morning meetings preference." },
            ],
            timestamp: Date.now(),
          },
        ];
        return;
      }

      agent.state.messages = [
        ...agent.state.messages,
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Should I reuse your morning preference for this meeting?",
            },
          ],
          timestamp: Date.now(),
        },
      ];
    };

    const runner = new EvalRunner({
      config,
      scenarios: [
        {
          id: "recall_preference_simple",
          title: "Recall preference",
          mode: "simulate",
          complexity: "simple",
          turns: [
            "I usually prefer morning meetings when possible.",
            "Can you help me schedule another meeting next week?",
          ],
          assertions: {
            recallNeedles: ["morning"],
            requiredMemoryTool: "record_user_preference",
          },
          rubricWeights: {
            recallRelevance: 1,
            planningCoherence: 1,
            consentPolicyAdherence: 1,
            proposalUsefulness: 1,
            efficiency: 1,
          },
        },
      ],
      mode: "simulate",
      outputDir,
      safePolicy: {
        enabled: true,
        safeWindow: {
          start: "2026-06-01T00:00:00.000Z",
          end: "2026-06-30T23:59:59.000Z",
        },
        eventPrefix: "[MINICLAW-EVAL]",
        requireTaggedEventForMutations: true,
      },
      throttle: {
        llmMaxConcurrency: 1,
        gwsMaxConcurrency: 1,
        llmCooldownMs: 0,
        gwsCooldownMs: 0,
        turnCooldownMs: 0,
        maxToolCallsPerScenario: 10,
      },
      scenarioTimeoutMs: 30000,
      turnTimeoutMs: 5000,
    });

    const summary = await runner.runAll();
    const latestSummary = await fs.readFile(
      path.join(outputDir, "latest", "summary.md"),
      "utf8",
    );

    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(latestSummary).toContain("recall_preference_simple: PASS");
  });

  it("routes sandbox-live execution through ask_user and shell exec records", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
    })) as unknown as typeof global.fetch;
    execMock.mockImplementation(
      (command: string, optionsOrCallback: any, maybeCallback?: any) => {
        const callback =
          typeof optionsOrCallback === "function"
            ? optionsOrCallback
            : maybeCallback;
        callback(null, {
          stdout: "Created event\nEvent ID: evt_eval_1\n",
          stderr: "",
        });
      },
    );

    agentHarness.FakeAgent.continueImpl = async (agent) => {
      const currentUserText =
        agent.options.initialState.messages.at(-1)?.content ||
        agent.state.messages.at(-1)?.content;
      const askUser = agent.options.initialState.tools.find(
        (tool: any) => tool.name === "ask_user",
      );
      const execTool = agent.options.initialState.tools.find(
        (tool: any) => tool.name === "exec",
      );

      if (String(currentUserText).includes("deep work")) {
        await askUser.execute("tool-propose", {
          question:
            "I can schedule a deep work block on June 12 2026. Proceed or cancel?",
          options: ["Proceed", "Cancel"],
        });
        return;
      }

      const result = await execTool.execute("tool-exec", {
        command:
          'gws calendar +insert --summary "[MINICLAW-EVAL] Deep work block" --start "2026-06-12T02:00:00.000Z" --end "2026-06-12T03:00:00.000Z"',
      });
      agent.state.messages = [
        ...agent.state.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: result.content[0].text }],
          timestamp: Date.now(),
        },
      ];
    };

    const runner = new EvalRunner({
      config,
      scenarios: [
        {
          id: "proposal_before_calendar_write",
          title: "Proposal then write",
          mode: "sandbox-live",
          complexity: "moderate",
          turns: [
            "Please make space for deep work on June 12 2026.",
            "Yes, schedule it.",
          ],
          assertions: {
            requireProposalBeforeWrite: true,
          },
          rubricWeights: {
            recallRelevance: 1,
            planningCoherence: 1,
            consentPolicyAdherence: 1,
            proposalUsefulness: 1,
            efficiency: 1,
          },
        },
      ],
      mode: "sandbox-live",
      outputDir,
      safePolicy: {
        enabled: true,
        safeWindow: {
          start: "2026-06-01T00:00:00.000Z",
          end: "2026-06-30T23:59:59.000Z",
        },
        eventPrefix: "[MINICLAW-EVAL]",
        requireTaggedEventForMutations: true,
      },
      throttle: {
        llmMaxConcurrency: 1,
        gwsMaxConcurrency: 1,
        llmCooldownMs: 0,
        gwsCooldownMs: 0,
        turnCooldownMs: 0,
        maxToolCallsPerScenario: 10,
      },
      scenarioTimeoutMs: 30000,
      turnTimeoutMs: 5000,
    });

    const summary = await runner.runAll();
    const reportDirEntries = await fs.readdir(outputDir, {
      withFileTypes: true,
    });
    const reportDir = reportDirEntries.find(
      (entry) => entry.isDirectory() && entry.name !== "latest",
    );
    const report = JSON.parse(
      await fs.readFile(
        path.join(
          outputDir,
          reportDir!.name,
          "proposal_before_calendar_write.json",
        ),
        "utf8",
      ),
    );

    expect(summary.passed).toBe(1);
    expect(execMock).toHaveBeenCalled();
    expect(
      report.shellExecutions.some(
        (entry: any) =>
          entry.classification.provider === "gws" &&
          entry.classification.action === "write",
      ),
    ).toBe(true);
  });

  it("marks every scenario as infra_failed when the ollama provider is unreachable", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof global.fetch;
    config = AppConfigSchema.parse({
      ...config,
      thread: {
        ...config.thread,
        provider: "ollama",
      },
    });

    const runner = new EvalRunner({
      config,
      scenarios: [
        {
          id: "recall_preference_simple",
          title: "Recall preference",
          mode: "sandbox-live",
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
      ],
      mode: "sandbox-live",
      outputDir,
      safePolicy: {
        enabled: true,
        safeWindow: {
          start: "2026-06-01T00:00:00.000Z",
          end: "2026-06-30T23:59:59.000Z",
        },
        eventPrefix: "[MINICLAW-EVAL]",
        requireTaggedEventForMutations: true,
      },
      throttle: {
        llmMaxConcurrency: 1,
        gwsMaxConcurrency: 1,
        llmCooldownMs: 0,
        gwsCooldownMs: 0,
        turnCooldownMs: 0,
        maxToolCallsPerScenario: 10,
      },
      scenarioTimeoutMs: 30000,
      turnTimeoutMs: 5000,
    });

    const summary = await runner.runAll();
    const reportDirEntries = await fs.readdir(outputDir, {
      withFileTypes: true,
    });
    const reportDir = reportDirEntries.find(
      (entry) => entry.isDirectory() && entry.name !== "latest",
    );
    const report = JSON.parse(
      await fs.readFile(
        path.join(outputDir, reportDir!.name, "recall_preference_simple.json"),
        "utf8",
      ),
    );

    expect(summary.failed).toBe(1);
    expect(summary.failuresByKind.infra_failed).toBe(1);
    expect(report.failureKind).toBe("infra_failed");
    expect(report.assertions[0].name).toBe("provider_availability");
  });

  it("classifies empty assistant-only runs without tool activity as infra failures", async () => {
    agentHarness.FakeAgent.continueImpl = async (agent) => {
      agent.state.messages = [
        ...agent.state.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          timestamp: Date.now(),
        },
      ];
    };

    const runner = new EvalRunner({
      config,
      scenarios: [
        {
          id: "clarify_missing_time_preference",
          title: "Clarify missing preference",
          mode: "simulate",
          complexity: "simple",
          turns: ["Please schedule a project check-in."],
          assertions: {
            requireClarification: true,
            clarificationNeedles: ["morning", "afternoon", "evening"],
          },
          rubricWeights: {
            recallRelevance: 1,
            planningCoherence: 1,
            consentPolicyAdherence: 1,
            proposalUsefulness: 1,
            efficiency: 1,
          },
        },
      ],
      mode: "simulate",
      outputDir,
      safePolicy: {
        enabled: true,
        safeWindow: {
          start: "2026-06-01T00:00:00.000Z",
          end: "2026-06-30T23:59:59.000Z",
        },
        eventPrefix: "[MINICLAW-EVAL]",
        requireTaggedEventForMutations: true,
      },
      throttle: {
        llmMaxConcurrency: 1,
        gwsMaxConcurrency: 1,
        llmCooldownMs: 0,
        gwsCooldownMs: 0,
        turnCooldownMs: 0,
        maxToolCallsPerScenario: 10,
      },
      scenarioTimeoutMs: 30000,
      turnTimeoutMs: 5000,
    });

    const summary = await runner.runAll();
    const reportDirEntries = await fs.readdir(outputDir, {
      withFileTypes: true,
    });
    const reportDir = reportDirEntries.find(
      (entry) => entry.isDirectory() && entry.name !== "latest",
    );
    const report = JSON.parse(
      await fs.readFile(
        path.join(
          outputDir,
          reportDir!.name,
          "clarify_missing_time_preference.json",
        ),
        "utf8",
      ),
    );

    expect(summary.failed).toBe(1);
    expect(report.failureKind).toBe("infra_failed");
  });
});
