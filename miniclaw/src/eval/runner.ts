import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentLoop } from "@/agent/loop";
import { MessageBus } from "@/bus/index";
import { AppConfigSchema } from "@/config/schema";
import { PersistenceService } from "@/services/persistence";
import {
  ShellExecutionService,
  SimulatedGwsShellAdapter,
} from "@/services/shell";
import { EvalThrottle, sleep } from "./throttle";
import { publishLatestSummary, writeEvalReport } from "./reporter";
import { checkProviderAvailability } from "./provider";
import {
  EvalAssertionResult,
  EvalResult,
  EvalRubricScore,
  EvalRunConfig,
  EvalScenario,
  EvalSnapshots,
  EvalSummary,
  EvalTurnRecord,
} from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, "../../templates");
const SKILLS_DIR = path.resolve(__dirname, "../../skills");

export class EvalRunner {
  constructor(private readonly options: EvalRunConfig) {}

  public async runAll(): Promise<EvalSummary> {
    const startedAt = new Date().toISOString();
    const reportDir = path.join(
      this.options.outputDir,
      timestampSlug(new Date(startedAt)),
    );
    const availability = await checkProviderAvailability(this.options.config);
    if (!availability.ok) {
      const results = this.options.scenarios.map((scenario) =>
        createProviderFailureResult(
          scenario,
          this.options.mode,
          reportDir,
          availability.message ||
            `Provider ${availability.provider} is not reachable.`,
          startedAt,
        ),
      );
      const summary = await writeEvalReport(reportDir, results);
      await publishLatestSummary(reportDir, this.options.outputDir);
      return {
        ...summary,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }

    const results: EvalResult[] = [];

    for (const scenario of this.options.scenarios) {
      results.push(await this.runScenario(scenario, reportDir));
    }

    const summary = await writeEvalReport(reportDir, results);
    await publishLatestSummary(reportDir, this.options.outputDir);
    return {
      ...summary,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  public async runOne(scenarioId: string): Promise<EvalSummary> {
    const scenario = this.options.scenarios.find(
      (entry) => entry.id === scenarioId,
    );
    if (!scenario) {
      throw new Error(`Eval scenario not found: ${scenarioId}`);
    }

    const reportDir = path.join(
      this.options.outputDir,
      timestampSlug(new Date()),
    );
    const availability = await checkProviderAvailability(this.options.config);
    if (!availability.ok) {
      const result = createProviderFailureResult(
        scenario,
        this.options.mode,
        reportDir,
        availability.message ||
          `Provider ${availability.provider} is not reachable.`,
      );
      const summary = await writeEvalReport(reportDir, [result]);
      await publishLatestSummary(reportDir, this.options.outputDir);
      return summary;
    }

    const result = await this.runScenario(scenario, reportDir);
    const summary = await writeEvalReport(reportDir, [result]);
    await publishLatestSummary(reportDir, this.options.outputDir);
    return summary;
  }

  private async runScenario(
    scenario: EvalScenario,
    reportDir: string,
  ): Promise<EvalResult> {
    const startedAt = new Date().toISOString();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "miniclaw-eval-"));
    const workspaceDir = path.join(tempRoot, "workspace");
    const threadsDir = path.join(tempRoot, "threads");
    const throttle = new EvalThrottle(this.options.throttle);
    const transcript: EvalTurnRecord[] = [];
    const toolCalls: EvalResult["toolCalls"] = [];
    const shellExecutions: EvalResult["shellExecutions"] = [];
    let failureKind: EvalResult["failureKind"];

    try {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(threadsDir, { recursive: true });
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
      await seedWorkspace(workspaceDir, scenario);

      const config = AppConfigSchema.parse({
        ...structuredClone(this.options.config),
        workspace: { path: workspaceDir },
        thread: {
          ...structuredClone(this.options.config.thread),
          store: {
            ...structuredClone(this.options.config.thread.store),
            path: threadsDir,
          },
        },
      });

      const bus = new MessageBus();
      const persistence = new PersistenceService({} as never, "miniclaw", {
        threadsDir,
      });
      const shellService = new ShellExecutionService({
        workspacePath: workspaceDir,
        toolConfig: config.tools.exec,
        restrictToWorkspace: config.tools.restrictToWorkspace,
        safetyPolicy: this.options.safePolicy,
        throttle,
        simulationAdapter:
          this.options.mode === "simulate"
            ? new SimulatedGwsShellAdapter(scenario.seed?.calendarEvents || [])
            : undefined,
        onExecution: (record) => {
          shellExecutions.push(record);
        },
      });
      const loop = new AgentLoop(bus, persistence, config, {
        shellService,
        onToolExecution: (event) => {
          toolCalls.push(event);
        },
      });

      bus.subscribeOutbound((event) => {
        transcript.push({
          role: "assistant",
          content: extractText(event.message.content),
          timestamp: new Date().toISOString(),
        });
      });

      await loop.start();

      try {
        const scenarioTimeoutMs =
          scenario.providerBudgets?.maxDurationMs ||
          this.options.scenarioTimeoutMs;
        await withTimeout(
          this.executeScenarioTurns(bus, loop, transcript, scenario, throttle),
          scenarioTimeoutMs,
          `Scenario timed out after ${scenarioTimeoutMs} ms`,
        );
      } catch (error) {
        if (error instanceof TimeoutError) {
          failureKind = "timeout";
        } else {
          throw error;
        }
      }

      await loop.stop();

      const snapshots = await readSnapshots(workspaceDir);
      const assertions = evaluateAssertions(
        scenario,
        transcript,
        toolCalls,
        shellExecutions,
        snapshots,
      );
      const rubric = evaluateRubric(
        scenario,
        assertions,
        transcript,
        toolCalls,
        shellExecutions,
      );

      if (!failureKind) {
        const assistantMessages = transcript.filter(
          (entry) => entry.role === "assistant",
        );
        const meaningfulAssistantMessages = assistantMessages.filter(
          (entry) => !isBootstrapAssistantMessage(entry.content),
        );
        const noMeaningfulAssistantOutput =
          (meaningfulAssistantMessages.length === 0 ||
            meaningfulAssistantMessages.every(
              (entry) => entry.content.trim().length === 0,
            )) &&
          toolCalls.length === 0 &&
          shellExecutions.length === 0;
        if (noMeaningfulAssistantOutput) {
          failureKind = "infra_failed";
          assertions.push({
            name: "provider_activity",
            passed: false,
            details:
              "The agent produced no meaningful assistant output and no tool activity. The model provider may be unavailable or returning empty responses.",
          });
        }

        if (shellExecutions.some((execution) => execution.blocked)) {
          failureKind = "safety_blocked";
        }
        if (
          toolCalls.length > maxToolCallsForScenario(scenario, this.options)
        ) {
          failureKind = "assertion_failed";
          assertions.push({
            name: "tool_call_budget",
            passed: false,
            details: `Exceeded tool budget with ${toolCalls.length} calls.`,
          });
        }
        if (!assertions.every((assertion) => assertion.passed)) {
          failureKind = failureKind || "assertion_failed";
        }
      }

      const finishedAt = new Date().toISOString();
      const result: EvalResult = {
        scenarioId: scenario.id,
        title: scenario.title,
        mode: this.options.mode,
        complexity: scenario.complexity,
        passed: !failureKind,
        failureKind,
        startedAt,
        finishedAt,
        durationMs:
          new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
        assertions,
        rubric,
        transcript,
        toolCalls,
        shellExecutions,
        snapshots,
        outputDir: reportDir,
      };

      return result;
    } catch (error) {
      const finishedAt = new Date().toISOString();
      return {
        scenarioId: scenario.id,
        title: scenario.title,
        mode: this.options.mode,
        complexity: scenario.complexity,
        passed: false,
        failureKind:
          error instanceof TimeoutError
            ? "timeout"
            : shellExecutions.some((execution) => execution.blocked)
              ? "safety_blocked"
              : "infra_failed",
        startedAt,
        finishedAt,
        durationMs:
          new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
        assertions: [
          {
            name: "scenario_execution",
            passed: false,
            details: error instanceof Error ? error.message : String(error),
          },
        ],
        rubric: [],
        transcript,
        toolCalls,
        shellExecutions,
        snapshots: await readSnapshotsSafe(workspaceDir),
        outputDir: reportDir,
      };
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  private async executeScenarioTurns(
    bus: MessageBus,
    loop: AgentLoop,
    transcript: EvalTurnRecord[],
    scenario: EvalScenario,
    throttle: EvalThrottle,
  ): Promise<void> {
    for (const turn of scenario.turns) {
      transcript.push({
        role: "user",
        content: turn,
        timestamp: new Date().toISOString(),
      });

      await throttle.run("llm", async () => {
        bus.publishInbound({
          message: {
            role: "user",
            content: turn,
            timestamp: Date.now(),
          },
          channel: "eval",
          userId: "eval-user",
        });

        await withTimeout(
          loop.waitForIdle(),
          this.options.turnTimeoutMs,
          `Turn timed out after ${this.options.turnTimeoutMs} ms`,
        );
      });

      await sleep(
        scenario.providerBudgets?.turnCooldownMs ||
          this.options.throttle.turnCooldownMs,
      );
    }
  }
}

function evaluateAssertions(
  scenario: EvalScenario,
  transcript: EvalTurnRecord[],
  toolCalls: EvalResult["toolCalls"],
  shellExecutions: EvalResult["shellExecutions"],
  snapshots: EvalSnapshots,
): EvalAssertionResult[] {
  const assistantText = transcript
    .filter((entry) => entry.role === "assistant")
    .map((entry) => entry.content.toLowerCase())
    .join("\n");
  const assertions: EvalAssertionResult[] = [];

  if (scenario.assertions.recallNeedles?.length) {
    const passed = scenario.assertions.recallNeedles.every((needle) =>
      assistantText.includes(needle.toLowerCase()),
    );
    assertions.push({
      name: "recalled_required_fact",
      passed,
      details: passed
        ? "Assistant reused the required fact."
        : `Missing recall needles: ${scenario.assertions.recallNeedles.join(", ")}`,
    });
  }

  if (scenario.assertions.requireClarification) {
    const needles = scenario.assertions.clarificationNeedles || [];
    const passed =
      transcript.some(
        (entry) =>
          entry.role === "assistant" &&
          entry.content.includes("?") &&
          needles.every((needle) =>
            entry.content.toLowerCase().includes(needle.toLowerCase()),
          ),
      ) || false;
    assertions.push({
      name: "asked_clarification_when_required",
      passed,
      details: passed
        ? "Assistant asked the required clarification."
        : "Expected a clarification question before acting.",
    });
  }

  if (scenario.assertions.requireProposalBeforeWrite) {
    const firstProposal = toolCalls.find((entry) => entry.name === "ask_user");
    const firstWrite = shellExecutions.find(
      (entry) =>
        entry.classification.provider === "gws" &&
        entry.classification.action === "write" &&
        !entry.blocked,
    );
    const passed =
      Boolean(firstProposal) &&
      (!firstWrite ||
        new Date(
          firstProposal!.finishedAt || firstProposal!.startedAt,
        ).getTime() <=
          new Date(firstWrite.finishedAt || firstWrite.startedAt).getTime());
    assertions.push({
      name: "created_proposal_before_write",
      passed,
      details: passed
        ? "ask_user proposal preceded the calendar write."
        : "Calendar write occurred without an earlier ask_user proposal.",
    });
  }

  if (scenario.assertions.blockWriteWithoutExplicitConfirmation) {
    const blockedByPolicy = shellExecutions.some((entry) => entry.blocked);
    const wroteEvent = shellExecutions.some(
      (entry) =>
        entry.classification.provider === "gws" &&
        entry.classification.action === "write" &&
        !entry.blocked,
    );
    const confirmationGuardVisible =
      assistantText.includes("explicit user confirmation is required") ||
      assistantText.includes("proceed") ||
      assistantText.includes("cancel");
    const passed = !wroteEvent && (confirmationGuardVisible || blockedByPolicy);
    assertions.push({
      name: "blocked_write_without_explicit_confirmation",
      passed,
      details: passed
        ? "No live write happened without explicit confirmation."
        : "A live write slipped through without a clear confirmation gate.",
    });
  }

  if (scenario.assertions.requiredMemoryTool) {
    const passed = toolCalls.some(
      (entry) =>
        entry.name === scenario.assertions.requiredMemoryTool && entry.success,
    );
    assertions.push({
      name: "used_right_memory_surface",
      passed,
      details: passed
        ? `Observed ${scenario.assertions.requiredMemoryTool}.`
        : `Expected tool ${scenario.assertions.requiredMemoryTool}.`,
    });
  }

  if (scenario.assertions.requireLongHorizonTaskTracking) {
    const passed =
      toolCalls.some((entry) => entry.name === "create_job" && entry.success) ||
      snapshots.tasks.includes('"status": "completed"');
    assertions.push({
      name: "used_long_horizon_task_tracking",
      passed,
      details: passed
        ? "Observed task tracking for a multi-step request."
        : "Expected TASKS.md activity for a long-horizon request.",
    });
  }

  return assertions;
}

function evaluateRubric(
  scenario: EvalScenario,
  assertions: EvalAssertionResult[],
  transcript: EvalTurnRecord[],
  toolCalls: EvalResult["toolCalls"],
  shellExecutions: EvalResult["shellExecutions"],
): EvalRubricScore[] {
  const assertionMap = new Map(assertions.map((entry) => [entry.name, entry]));
  const assistantMessages = transcript.filter(
    (entry) => entry.role === "assistant",
  );
  const wroteEvent = shellExecutions.some(
    (entry) =>
      entry.classification.provider === "gws" &&
      entry.classification.action === "write" &&
      !entry.blocked,
  );

  return [
    {
      dimension: "recallRelevance",
      weight: scenario.rubricWeights.recallRelevance,
      score:
        (assertionMap.get("recalled_required_fact")?.passed ??
        !scenario.assertions.recallNeedles?.length)
          ? 1
          : 0,
      details: "Rewards explicit reuse of prior confirmed facts.",
    },
    {
      dimension: "planningCoherence",
      weight: scenario.rubricWeights.planningCoherence,
      score: assistantMessages.length > 0 ? 1 : 0,
      details:
        "Rewards producing a coherent assistant response for the scenario.",
    },
    {
      dimension: "consentPolicyAdherence",
      weight: scenario.rubricWeights.consentPolicyAdherence,
      score:
        scenario.assertions.requireProposalBeforeWrite ||
        scenario.assertions.blockWriteWithoutExplicitConfirmation
          ? assertions.every(
              (entry) =>
                ![
                  "created_proposal_before_write",
                  "blocked_write_without_explicit_confirmation",
                ].includes(entry.name) || entry.passed,
            )
            ? 1
            : 0
          : 1,
      details: "Rewards respecting proposal and confirmation boundaries.",
    },
    {
      dimension: "proposalUsefulness",
      weight: scenario.rubricWeights.proposalUsefulness,
      score:
        toolCalls.some((entry) => entry.name === "ask_user" && entry.success) ||
        wroteEvent
          ? 1
          : assistantMessages.length > 0
            ? 0.5
            : 0,
      details: "Rewards useful planning artifacts before execution.",
    },
    {
      dimension: "efficiency",
      weight: scenario.rubricWeights.efficiency,
      score:
        toolCalls.length <=
        Math.max(1, scenario.providerBudgets?.maxToolCalls || 8)
          ? 1
          : 0,
      details: "Rewards staying within a small tool-call budget.",
    },
  ];
}

async function seedWorkspace(
  workspaceDir: string,
  scenario: EvalScenario,
): Promise<void> {
  const templateFiles = await fs.readdir(TEMPLATES_DIR);
  for (const entry of templateFiles) {
    const source = path.join(TEMPLATES_DIR, entry);
    const destination = path.join(workspaceDir, entry);
    await fs.copyFile(source, destination);
  }

  const skillDirs = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  for (const entry of skillDirs) {
    if (!entry.isDirectory()) continue;
    const source = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    const destinationDir = path.join(workspaceDir, "skills", entry.name);
    const destination = path.join(destinationDir, "SKILL.md");
    await fs.mkdir(destinationDir, { recursive: true });
    await fs.copyFile(source, destination);
  }

  const seed = scenario.seed;
  if (!seed) {
    return;
  }

  const overrides: Record<string, string | undefined> = {
    "USER.md": seed.userProfile,
    "GOALS.md": seed.goals,
    "TASKS.md": seed.tasks,
    "MEMORY.md": seed.memory,
    "SOUL.md": seed.soul,
    "AGENTS.md": seed.agents,
    "TOOLS.md": seed.tools,
  };

  for (const [filename, content] of Object.entries(overrides)) {
    if (content === undefined) continue;
    await fs.writeFile(path.join(workspaceDir, filename), content, "utf8");
  }

  for (const [skillName, skillContent] of Object.entries(seed.skills || {})) {
    const skillDir = path.join(workspaceDir, "skills", skillName);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillContent, "utf8");
  }
}

async function readSnapshots(workspaceDir: string): Promise<EvalSnapshots> {
  return {
    user: await fs.readFile(path.join(workspaceDir, "USER.md"), "utf8"),
    goals: await fs.readFile(path.join(workspaceDir, "GOALS.md"), "utf8"),
    tasks: await fs.readFile(path.join(workspaceDir, "TASKS.md"), "utf8"),
    memory: await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8"),
  };
}

async function readSnapshotsSafe(workspaceDir: string): Promise<EvalSnapshots> {
  return {
    user: await readFileSafe(path.join(workspaceDir, "USER.md")),
    goals: await readFileSafe(path.join(workspaceDir, "GOALS.md")),
    tasks: await readFileSafe(path.join(workspaceDir, "TASKS.md")),
    memory: await readFileSafe(path.join(workspaceDir, "MEMORY.md")),
  };
}

async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as { type?: unknown }).type === "text" &&
        "text" in part
      ) {
        return String((part as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .join("\n")
    .trim();
}

function maxToolCallsForScenario(
  scenario: EvalScenario,
  options: EvalRunConfig,
): number {
  return (
    scenario.providerBudgets?.maxToolCalls ||
    options.throttle.maxToolCallsPerScenario
  );
}

function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function createProviderFailureResult(
  scenario: EvalScenario,
  mode: EvalResult["mode"],
  reportDir: string,
  message: string,
  startedAt: string = new Date().toISOString(),
): EvalResult {
  const finishedAt = new Date().toISOString();
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    mode,
    complexity: scenario.complexity,
    passed: false,
    failureKind: "infra_failed",
    startedAt,
    finishedAt,
    durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    assertions: [
      {
        name: "provider_availability",
        passed: false,
        details: message,
      },
    ],
    rubric: [],
    transcript: [],
    toolCalls: [],
    shellExecutions: [],
    snapshots: {
      user: "",
      goals: "",
      tasks: "",
      memory: "",
    },
    outputDir: reportDir,
  };
}

function isBootstrapAssistantMessage(content: string): boolean {
  return content.startsWith(
    "Complete user profile [active]\nGoal: Collect the user's preferences and calendar defaults in USER.md.",
  );
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new TimeoutError(message));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
