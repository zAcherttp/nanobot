import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageBus } from "../src/bus/index";
import { PersistenceService } from "../src/services/persistence";
import { AppConfigSchema, type AppConfig } from "../src/config/schema";
import { GoalService } from "../src/services/goals";
import { TaskService } from "../src/services/tasks";
import { UserProfileService } from "../src/services/user_profile";

const pathState = vi.hoisted(() => ({ root: "" }));

vi.mock("../src/utils/paths", () => ({
  getRootDir: () => pathState.root,
  getConfigPath: (appName = "miniclaw") =>
    `${pathState.root}/${appName}/config.json`,
  resolvePath: (...parts: string[]) => `${pathState.root}/${parts.join("/")}`,
}));

const agentHarness = vi.hoisted(() => {
  type Listener = (event: unknown) => void | Promise<void>;

  class FakeAgent {
    public static instances: FakeAgent[] = [];
    public static continueImpl: ((agent: FakeAgent) => Promise<void>) | null =
      null;
    public static waitForIdleImpl:
      | ((agent: FakeAgent) => Promise<void>)
      | null = null;

    public readonly options: any;
    public readonly listeners: Listener[] = [];
    public state: { messages: any[] };

    constructor(options: any) {
      this.options = options;
      this.state = {
        messages: [...(options.initialState.messages || [])],
      };
      FakeAgent.instances.push(this);
    }

    subscribe(listener: Listener) {
      this.listeners.push(listener);
    }

    async continue() {
      if (FakeAgent.continueImpl) {
        await FakeAgent.continueImpl(this);
      }
    }

    async waitForIdle() {
      if (FakeAgent.waitForIdleImpl) {
        await FakeAgent.waitForIdleImpl(this);
      }
    }

    async emitTextDelta(delta: string) {
      for (const listener of this.listeners) {
        await listener({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta,
          },
        });
      }
    }
  }

  return { FakeAgent };
});

const providerHarness = vi.hoisted(() => ({
  getModelImpl: vi.fn(() => ({
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

const gwsHarness = vi.hoisted(() => ({
  createEvent: vi.fn(async () => "evt-123"),
  updateEvent: vi.fn(async () => {}),
  deleteEvent: vi.fn(async () => {}),
  listEvents: vi.fn(async () => []),
  getEvent: vi.fn(async () => null),
}));

vi.mock("@mariozechner/pi-agent-core", () => ({
  Agent: agentHarness.FakeAgent,
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn((provider: string, modelId: string) =>
    providerHarness.getModelImpl(provider, modelId),
  ),
  registerBuiltInApiProviders: providerHarness.registerBuiltInApiProviders,
}));

vi.mock("../src/services/calendar/gws", () => ({
  GwsCalendarService: class {
    name = "GWS (Google Workspace)";

    async createEvent(event: unknown) {
      return gwsHarness.createEvent(event);
    }

    async updateEvent(eventId: string, event: unknown) {
      return gwsHarness.updateEvent(eventId, event);
    }

    async deleteEvent(eventId: string) {
      return gwsHarness.deleteEvent(eventId);
    }

    async listEvents(start: Date, end: Date) {
      return gwsHarness.listEvents(start, end);
    }

    async getEvent(eventId: string) {
      return gwsHarness.getEvent(eventId);
    }
  },
}));

describe.sequential("AgentLoop integration", () => {
  let tempDir: string;
  let workspaceDir: string;
  let bus: MessageBus;
  let persistence: PersistenceService;
  let config: AppConfig;
  let taskService: TaskService;
  let profileService: UserProfileService;
  let goalService: GoalService;
  const startedLoops: Array<{ stop: () => void }> = [];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "miniclaw-loop-"));
    workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(path.join(workspaceDir, "skills", "gws-calendar-agenda"), {
      recursive: true,
    });
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      "Agent instructions",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "TASKS.md"),
      `# TASKS.md

## Active Jobs
<!-- miniclaw:active-jobs:start -->
\`\`\`json
[]
\`\`\`
<!-- miniclaw:active-jobs:end -->

## Archived Jobs
<!-- miniclaw:archived-jobs:start -->
\`\`\`json
[]
\`\`\`
<!-- miniclaw:archived-jobs:end -->
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "USER.md"),
      `# User Profile

## Managed Profile
<!-- miniclaw:managed-profile:start -->
\`\`\`json
{
  "setupComplete": true,
  "name": "Test User",
  "timezone": "Asia/Saigon",
  "language": "English",
  "communicationStyle": "technical",
  "responseLength": "adaptive",
  "technicalLevel": "expert",
  "calendarProvider": "gws",
  "defaultCalendar": "primary"
}
\`\`\`
<!-- miniclaw:managed-profile:end -->
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "skills", "gws-calendar-agenda", "SKILL.md"),
      `---
name: gws-calendar-agenda
description: Show upcoming Google Calendar events
---

# GWS Agenda

Use gws calendar +agenda.`,
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      `# MEMORY.md

## Decisions
<!-- miniclaw:memory-decisions:start -->
\`\`\`json
[
  {
    "id": "mem1",
    "category": "decision",
    "summary": "Use gws for calendar execution.",
    "tags": ["calendar"],
    "createdAt": "2026-05-02T00:00:00.000Z",
    "updatedAt": "2026-05-02T00:00:00.000Z"
  }
]
\`\`\`
<!-- miniclaw:memory-decisions:end -->

## Conventions
<!-- miniclaw:memory-conventions:start -->
\`\`\`json
[]
\`\`\`
<!-- miniclaw:memory-conventions:end -->

## Constraints
<!-- miniclaw:memory-constraints:start -->
\`\`\`json
[]
\`\`\`
<!-- miniclaw:memory-constraints:end -->

## Attempts and Outcomes
<!-- miniclaw:memory-attempts:start -->
\`\`\`json
[]
\`\`\`
<!-- miniclaw:memory-attempts:end -->
`,
      "utf8",
    );

    pathState.root = tempDir;
    bus = new MessageBus();
    persistence = new PersistenceService({} as never, "miniclaw");
    taskService = new TaskService(workspaceDir);
    profileService = new UserProfileService(workspaceDir);
    goalService = new GoalService(workspaceDir);
    config = AppConfigSchema.parse({
      workspace: { path: workspaceDir },
      memory: { enabled: true, maxMemories: 1000 },
      dream: { enabled: false },
      thread: {
        provider: "openai",
        modelId: "gpt-test",
        contextWindowTokens: 64,
        maxTokens: 256,
        compaction: {
          thresholdRatio: 0.5,
          keepRecentMessages: 2,
          maxRetries: 1,
          retryDelayMs: 1000,
        },
      },
    });

    agentHarness.FakeAgent.instances = [];
    agentHarness.FakeAgent.continueImpl = null;
    agentHarness.FakeAgent.waitForIdleImpl = null;
    providerHarness.getModelImpl.mockReset();
    providerHarness.getModelImpl.mockImplementation(() => ({
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
    }));
    gwsHarness.createEvent.mockClear();
    gwsHarness.updateEvent.mockClear();
    gwsHarness.deleteEvent.mockClear();
    gwsHarness.listEvents.mockReset();
    gwsHarness.listEvents.mockImplementation(async () => []);
    gwsHarness.getEvent.mockReset();
    gwsHarness.getEvent.mockImplementation(async () => null);
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    while (startedLoops.length > 0) {
      startedLoops.pop()?.stop();
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("persists inbound history, streams deltas, and stores the final assistant reply", async () => {
    const { AgentLoop } = await import("../src/agent/loop");
    const deltas: string[] = [];
    const outbound: string[] = [];

    bus.subscribeStreamDelta((event) => {
      deltas.push(event.delta);
    });
    bus.subscribeOutbound((event) => {
      outbound.push(extractText(event.message.content));
    });

    agentHarness.FakeAgent.continueImpl = async (agent) => {
      await agent.emitTextDelta("Hello");
      await agent.emitTextDelta(" world");
      agent.state.messages = [
        ...agent.state.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
          timestamp: Date.now(),
        },
      ];
    };

    const loop = new AgentLoop(bus, persistence, config);
    await loop.start();
    startedLoops.push(loop);

    bus.publishInbound({
      message: {
        role: "user",
        content: "ping",
        timestamp: Date.now(),
      },
      channel: "cli",
      userId: "user-1",
    });

    await waitFor(async () => outbound.length === 1);

    const thread = await persistence.getConversationThread();
    const persistedMessages = await persistence.getMessages(thread.id);
    const agentInstance = agentHarness.FakeAgent.instances[0];

    expect(deltas).toEqual(["Hello", " world"]);
    expect(outbound).toEqual(["Hello world"]);
    expect(persistedMessages).toHaveLength(2);
    expect(extractText(persistedMessages[1].content)).toBe("Hello world");
    expect(agentInstance.options.initialState.systemPrompt).toContain(
      "## USER.md",
    );
    expect(agentInstance.options.initialState.systemPrompt).toContain(
      "## GOALS.md",
    );
    expect(agentInstance.options.initialState.systemPrompt).toContain(
      "## TASKS.md",
    );
    expect(agentInstance.options.initialState.systemPrompt).toContain(
      "## MEMORY.md",
    );
    expect(
      agentInstance.options.initialState.tools.map((tool: any) => tool.name),
    ).toEqual(
      expect.arrayContaining([
        "list_skills",
        "load_skill",
        "list_jobs",
        "create_job",
        "get_user_profile",
        "update_user_profile",
        "record_user_preference",
        "record_memory_entry",
        "list_goals",
        "gws_calendar_agenda",
        "propose_plan",
        "execute_plan",
      ]),
    );
  });

  it("reuses an explicitly recorded user preference on a later similar request", async () => {
    const { AgentLoop } = await import("../src/agent/loop");
    const outbound: string[] = [];
    let secondTurnValidated = false;

    bus.subscribeOutbound((event) => {
      outbound.push(extractText(event.message.content));
    });

    agentHarness.FakeAgent.continueImpl = async (agent) => {
      if (!outbound.includes("Noted your meeting preference.")) {
        const recordPreference = agent.options.initialState.tools.find(
          (tool: any) => tool.name === "record_user_preference",
        );
        await recordPreference.execute("tool-pref", {
          preference: "Prefers morning meetings when possible.",
        });
        agent.state.messages = [
          ...agent.state.messages,
          {
            role: "assistant",
            content: [{ type: "text", text: "Noted your meeting preference." }],
            timestamp: Date.now(),
          },
        ];
        return;
      }

      secondTurnValidated = true;
      expect(agent.options.initialState.systemPrompt).toContain(
        "Prefers morning meetings when possible.",
      );
      expect(agent.options.initialState.systemPrompt).toContain(
        "## Relevant Prior Conversation",
      );

      agent.state.messages = [
        ...agent.state.messages,
        {
          role: "assistant",
          content: [
            { type: "text", text: "Should I reuse your morning preference?" },
          ],
          timestamp: Date.now(),
        },
      ];
    };

    const loop = new AgentLoop(bus, persistence, config);
    await loop.start();
    startedLoops.push(loop);

    bus.publishInbound({
      message: {
        role: "user",
        content: "I usually want morning meetings.",
        timestamp: Date.now(),
      },
      channel: "cli",
      userId: "user-1",
    });
    await waitFor(async () =>
      outbound.includes("Noted your meeting preference."),
    );

    bus.publishInbound({
      message: {
        role: "user",
        content: "Can you help me schedule another meeting?",
        timestamp: Date.now(),
      },
      channel: "cli",
      userId: "user-1",
    });
    await waitFor(
      async () =>
        secondTurnValidated &&
        outbound.includes("Should I reuse your morning preference?"),
    );
  });

  it("reuses workspace memory on a later similar request", async () => {
    const { AgentLoop } = await import("../src/agent/loop");
    const outbound: string[] = [];
    let secondTurnValidated = false;

    bus.subscribeOutbound((event) => {
      outbound.push(extractText(event.message.content));
    });

    agentHarness.FakeAgent.continueImpl = async (agent) => {
      if (!outbound.includes("Saved the weekly review convention.")) {
        const recordMemory = agent.options.initialState.tools.find(
          (tool: any) => tool.name === "record_memory_entry",
        );
        await recordMemory.execute("tool-mem", {
          category: "convention",
          summary: "Use 25-minute planning blocks for weekly review.",
          tags: ["planning", "weekly-review"],
        });
        agent.state.messages = [
          ...agent.state.messages,
          {
            role: "assistant",
            content: [
              { type: "text", text: "Saved the weekly review convention." },
            ],
            timestamp: Date.now(),
          },
        ];
        return;
      }

      secondTurnValidated = true;
      expect(agent.options.initialState.systemPrompt).toContain(
        "## Relevant Memory",
      );
      expect(agent.options.initialState.systemPrompt).toContain(
        "Use 25-minute planning blocks for weekly review.",
      );

      agent.state.messages = [
        ...agent.state.messages,
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I'll use the saved weekly review convention.",
            },
          ],
          timestamp: Date.now(),
        },
      ];
    };

    const loop = new AgentLoop(bus, persistence, config);
    await loop.start();
    startedLoops.push(loop);

    bus.publishInbound({
      message: {
        role: "user",
        content: "Let's use 25-minute planning blocks for weekly review.",
        timestamp: Date.now(),
      },
      channel: "cli",
      userId: "user-1",
    });
    await waitFor(async () =>
      outbound.includes("Saved the weekly review convention."),
    );

    bus.publishInbound({
      message: {
        role: "user",
        content: "Help me plan the weekly review again.",
        timestamp: Date.now(),
      },
      channel: "cli",
      userId: "user-1",
    });
    await waitFor(
      async () =>
        secondTurnValidated &&
        outbound.includes("I'll use the saved weekly review convention."),
    );
  });

  it("compacts oversized history and saves the generated summary", async () => {
    const { AgentLoop } = await import("../src/agent/loop");
    const longText = "x".repeat(240);

    agentHarness.FakeAgent.continueImpl = async (agent) => {
      agent.state.messages = [
        ...agent.state.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: longText }],
          timestamp: Date.now(),
        },
      ];
    };

    const loop = new AgentLoop(bus, persistence, config);
    await loop.start();
    startedLoops.push(loop);

    bus.publishInbound({
      message: {
        role: "user",
        content: longText,
        timestamp: Date.now(),
      },
      channel: "cli",
      userId: "user-1",
    });
    await waitFor(async () => {
      const thread = await persistence.getConversationThread();
      return (await persistence.getMessages(thread.id)).length === 2;
    });

    bus.publishInbound({
      message: {
        role: "user",
        content: longText,
        timestamp: Date.now(),
      },
      channel: "cli",
      userId: "user-1",
    });
    await waitFor(async () => {
      try {
        const thread = await persistence.getConversationThread();
        const meta = await persistence.getThread(thread.id);
        const summary = await persistence.getSummary(thread.id);
        const messages = await persistence.getMessages(thread.id);

        return (
          meta.status === "compacted" &&
          typeof summary === "string" &&
          summary.length > 0 &&
          messages[messages.length - 1]?.role === "assistant"
        );
      } catch {
        return false;
      }
    });

    const thread = await persistence.getConversationThread();
    const meta = await persistence.getThread(thread.id);
    const summary = await persistence.getSummary(thread.id);
    const persistedMessages = await persistence.getMessages(thread.id);

    expect(meta.status).toBe("compacted");
    expect(summary).toContain("This conversation contains");
    expect(persistedMessages.length).toBeLessThanOrEqual(3);
  });

  it("falls back to a synthetic provider model when getModel throws", async () => {
    const { AgentLoop } = await import("../src/agent/loop");

    providerHarness.getModelImpl.mockImplementation(() => {
      throw new Error("unknown model");
    });
    config = AppConfigSchema.parse({
      ...config,
      thread: {
        ...config.thread,
        provider: "nvidia",
        modelId: "fallback-model",
      },
    });

    agentHarness.FakeAgent.continueImpl = async (agent) => {
      agent.state.messages = [
        ...agent.state.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: "fallback ok" }],
          timestamp: Date.now(),
        },
      ];
    };

    const loop = new AgentLoop(bus, persistence, config);
    await loop.start();
    startedLoops.push(loop);

    bus.publishInbound({
      message: {
        role: "user",
        content: "test fallback",
        timestamp: Date.now(),
      },
      channel: "cli",
    });

    await waitFor(async () => agentHarness.FakeAgent.instances.length === 1);

    const model =
      agentHarness.FakeAgent.instances[0].options.initialState.model;

    expect(model.provider).toBe("nvidia");
    expect(model.api).toBe("openai-responses");
    expect(model.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
  });

  it("keeps calendar skills as guidance while GWS tools remain the only execution path", async () => {
    const { AgentLoop } = await import("../src/agent/loop");
    const loop = new AgentLoop(bus, persistence, config);
    await loop.start();
    startedLoops.push(loop);

    agentHarness.FakeAgent.continueImpl = async (agent) => {
      const loadSkill = agent.options.initialState.tools.find(
        (tool: any) => tool.name === "load_skill",
      );
      const result = await loadSkill.execute("tool-1", {
        skill_name: "gws-calendar-agenda",
      });
      expect(result.content[0].text).toContain("gws calendar +agenda");

      agent.state.messages = [
        ...agent.state.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: "agenda ready" }],
          timestamp: Date.now(),
        },
      ];
    };

    bus.publishInbound({
      message: {
        role: "user",
        content: "show my agenda",
        timestamp: Date.now(),
      },
      channel: "cli",
    });

    await waitFor(async () => agentHarness.FakeAgent.instances.length === 1);
    const agentInstance = agentHarness.FakeAgent.instances[0];
    expect(agentInstance.options.initialState.systemPrompt).not.toContain(
      "gws calendar +agenda",
    );
  });

  it("creates a calendar proposal first, then executes it only after explicit confirmation", async () => {
    const { AgentLoop } = await import("../src/agent/loop");
    const outbound: string[] = [];
    const goal = await goalService.addGoal({
      title: "Protect deep work time",
      rationale: "Reserve focused hours for thesis writing.",
      timeHorizon: "this month",
    });
    let proposalJobId = "";
    let turn = 0;

    bus.subscribeOutbound((event) => {
      outbound.push(extractText(event.message.content));
    });

    agentHarness.FakeAgent.continueImpl = async (agent) => {
      turn += 1;
      const proposeInsert = agent.options.initialState.tools.find(
        (tool: any) => tool.name === "propose_plan",
      );
      const executeInsert = agent.options.initialState.tools.find(
        (tool: any) => tool.name === "execute_plan",
      );

      if (turn === 1) {
        const result = await proposeInsert.execute("tool-1", {
          plan_type: "gws_calendar_insert",
          title: "Deep work block",
          start: "2026-05-03T09:00:00.000Z",
          end: "2026-05-03T10:30:00.000Z",
          description: "Protected writing time",
          related_goal_id: goal.id,
        });
        proposalJobId = result.details.job.id;
        agent.state.messages = [
          ...agent.state.messages,
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I propose a deep work block tomorrow morning. Confirm if you want me to schedule it.",
              },
            ],
            timestamp: Date.now(),
          },
        ];
        return;
      }

      const result = await executeInsert.execute("tool-2", {
        job_id: proposalJobId,
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

    const loop = new AgentLoop(bus, persistence, config);
    await loop.start();
    startedLoops.push(loop);

    bus.publishInbound({
      message: {
        role: "user",
        content: "Please help me make time for thesis writing tomorrow.",
        timestamp: Date.now(),
      },
      channel: "cli",
      userId: "user-1",
    });

    await waitFor(async () => {
      const proposal = await taskService.findActiveJobByKind("pending-plan");
      const thread = await persistence.getConversationThread();
      const messages = await persistence.getMessages(thread.id);
      return (
        Boolean(proposal) &&
        messages.length === 2 &&
        extractText(messages[1].content).includes("I propose a deep work block")
      );
    });

    let proposalJob = await taskService.findActiveJobByKind("pending-plan");
    expect(proposalJob?.id).toBe(proposalJobId);
    expect(gwsHarness.createEvent).not.toHaveBeenCalled();

    bus.publishInbound({
      message: {
        role: "user",
        content: "Yes, schedule it.",
        timestamp: Date.now(),
      },
      channel: "cli",
      userId: "user-1",
    });

    await waitFor(
      async () =>
        gwsHarness.createEvent.mock.calls.length === 1 &&
        outbound.some((message) =>
          message.includes(
            'Created Google Calendar event evt-123 for "Deep work block".',
          ),
        ),
    );

    proposalJob = await taskService.findActiveJobByKind("pending-plan");
    const archivedJobs = await taskService.listJobs("archived");
    const updatedGoal = await goalService.getGoal(goal.id);

    expect(proposalJob).toBeNull();
    expect(
      archivedJobs.some(
        (job) =>
          job.id === proposalJobId &&
          job.outcomeSummary?.includes(
            "Executed plan by creating Google Calendar event evt-123.",
          ),
      ),
    ).toBe(true);
    expect(updatedGoal?.linkedTaskIds).toContain(proposalJobId);
    expect(updatedGoal?.progress.at(-1)?.summary).toContain(
      'Scheduled "Deep work block" on the calendar.',
    );
    expect(
      outbound.some((message) =>
        message.includes(
          'Created Google Calendar event evt-123 for "Deep work block".',
        ),
      ),
    ).toBe(true);
  });

  it("does not execute a proposed calendar write on ambiguous confirmation", async () => {
    const { AgentLoop } = await import("../src/agent/loop");
    let proposalJobId = "";
    let turn = 0;
    const outbound: string[] = [];

    bus.subscribeOutbound((event) => {
      outbound.push(extractText(event.message.content));
    });

    agentHarness.FakeAgent.continueImpl = async (agent) => {
      turn += 1;
      const proposeInsert = agent.options.initialState.tools.find(
        (tool: any) => tool.name === "propose_plan",
      );
      const executeInsert = agent.options.initialState.tools.find(
        (tool: any) => tool.name === "execute_plan",
      );

      if (turn === 1) {
        const result = await proposeInsert.execute("tool-1", {
          plan_type: "gws_calendar_insert",
          title: "Team sync prep",
          start: "2026-05-04T08:00:00.000Z",
          end: "2026-05-04T08:30:00.000Z",
        });
        proposalJobId = result.details.job.id;
        agent.state.messages = [
          ...agent.state.messages,
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I drafted a proposal. Confirm if you want me to place it on the calendar.",
              },
            ],
            timestamp: Date.now(),
          },
        ];
        return;
      }

      try {
        await executeInsert.execute("tool-2", { job_id: proposalJobId });
      } catch (error) {
        agent.state.messages = [
          ...agent.state.messages,
          {
            role: "assistant",
            content: [{ type: "text", text: (error as Error).message }],
            timestamp: Date.now(),
          },
        ];
      }
    };

    const loop = new AgentLoop(bus, persistence, config);
    await loop.start();
    startedLoops.push(loop);

    bus.publishInbound({
      message: {
        role: "user",
        content: "Set up prep time for the team sync.",
        timestamp: Date.now(),
      },
      channel: "cli",
      userId: "user-1",
    });

    await waitFor(async () => {
      const proposal = await taskService.findActiveJobByKind("pending-plan");
      const thread = await persistence.getConversationThread();
      const messages = await persistence.getMessages(thread.id);
      return (
        Boolean(proposal) &&
        messages.length === 2 &&
        extractText(messages[1].content).includes("I drafted a proposal.")
      );
    });

    bus.publishInbound({
      message: {
        role: "user",
        content: "maybe later",
        timestamp: Date.now(),
      },
      channel: "cli",
      userId: "user-1",
    });

    await waitFor(async () =>
      outbound.some((message) =>
        message.includes("Explicit user confirmation is required"),
      ),
    );

    const activeProposal =
      await taskService.findActiveJobByKind("pending-plan");
    expect(activeProposal?.id).toBe(proposalJobId);
    expect(gwsHarness.createEvent).not.toHaveBeenCalled();
  });

  it("does not emit a final outbound event when the turn ends without an assistant reply", async () => {
    const { AgentLoop } = await import("../src/agent/loop");
    let outboundCount = 0;

    bus.subscribeOutbound(() => {
      outboundCount += 1;
    });

    agentHarness.FakeAgent.continueImpl = async () => {};

    const loop = new AgentLoop(bus, persistence, config);
    await loop.start();
    startedLoops.push(loop);

    bus.publishInbound({
      message: {
        role: "user",
        content: "user only",
        timestamp: Date.now(),
      },
      channel: "cli",
    });

    await waitFor(async () => {
      const thread = await persistence.getConversationThread();
      return (await persistence.getMessages(thread.id)).length === 1;
    });

    expect(outboundCount).toBe(0);
  });

  it("contains turn failures and keeps the inbound subscription alive for later turns", async () => {
    const { AgentLoop } = await import("../src/agent/loop");
    const outbound: string[] = [];
    let callCount = 0;

    bus.subscribeOutbound((event) => {
      outbound.push(extractText(event.message.content));
    });

    agentHarness.FakeAgent.continueImpl = async (agent) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("boom");
      }

      agent.state.messages = [
        ...agent.state.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: "recovered" }],
          timestamp: Date.now(),
        },
      ];
    };

    const loop = new AgentLoop(bus, persistence, config);
    await loop.start();
    startedLoops.push(loop);

    bus.publishInbound({
      message: {
        role: "user",
        content: "first",
        timestamp: Date.now(),
      },
      channel: "cli",
    });

    await waitFor(async () => {
      const thread = await persistence.getConversationThread();
      return (await persistence.getMessages(thread.id)).length === 1;
    });

    bus.publishInbound({
      message: {
        role: "user",
        content: "second",
        timestamp: Date.now(),
      },
      channel: "cli",
    });

    await waitFor(async () => outbound.length === 1);

    expect(outbound).toEqual(["recovered"]);
  });

  it("tears down dream and cron resources on stop and ignores inbound events afterward", async () => {
    const { AgentLoop } = await import("../src/agent/loop");
    const cronStorePath = path.join(workspaceDir, "cron", "store.json");

    config = AppConfigSchema.parse({
      ...config,
      dream: {
        enabled: true,
        schedule: "0 2 * * *",
        maxEntriesPerDream: 10,
        minMessagesForDream: 5,
      },
    });

    let continueCalls = 0;
    agentHarness.FakeAgent.continueImpl = async (agent) => {
      continueCalls += 1;
      agent.state.messages = [
        ...agent.state.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: "should not run" }],
          timestamp: Date.now(),
        },
      ];
    };

    const loop = new AgentLoop(bus, persistence, config);
    await loop.start();
    startedLoops.push(loop);

    const cronService = (loop as any).cronService;
    await cronService.addJob(
      "user-job",
      { kind: "every", everyMs: 60_000 },
      "tick",
    );

    await waitFor(async () => {
      const store = JSON.parse(await fs.readFile(cronStorePath, "utf8"));
      return store.jobs.length === 2;
    });

    await loop.stop();

    expect(cronService.status()).toMatchObject({ enabled: false, jobs: 1 });
    expect((cronService as any).tasks.size).toBe(0);

    const store = JSON.parse(await fs.readFile(cronStorePath, "utf8"));
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0].name).toBe("user-job");

    bus.publishInbound({
      message: {
        role: "user",
        content: "after stop",
        timestamp: Date.now(),
      },
      channel: "cli",
      userId: "user-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const thread = await persistence.getConversationThread();
    expect(await persistence.getMessages(thread.id)).toHaveLength(0);
    expect(continueCalls).toBe(0);
  });

  it("auto-injects and archives the onboarding job as the profile becomes complete", async () => {
    const { AgentLoop } = await import("../src/agent/loop");
    const outbound: string[] = [];

    await profileService.updateProfile({
      name: "",
      timezone: "",
      language: "",
      communicationStyle: "",
      responseLength: "",
      technicalLevel: "",
      calendarProvider: "",
      defaultCalendar: "",
    });

    bus.subscribeOutbound((event) => {
      outbound.push(extractText(event.message.content));
    });

    let turn = 0;
    agentHarness.FakeAgent.continueImpl = async (agent) => {
      turn += 1;
      const updateProfile = agent.options.initialState.tools.find(
        (tool: any) => tool.name === "update_user_profile",
      );

      if (turn === 1) {
        await updateProfile.execute("tool-1", {
          name: "Test User",
          timezone: "Asia/Saigon",
          language: "English",
          communicationStyle: "technical",
        });
        agent.state.messages = [
          ...agent.state.messages,
          {
            role: "assistant",
            content: [{ type: "text", text: "Need a few more preferences." }],
            timestamp: Date.now(),
          },
        ];
        return;
      }

      await updateProfile.execute("tool-2", {
        responseLength: "adaptive",
        technicalLevel: "expert",
        calendarProvider: "gws",
        defaultCalendar: "primary",
      });
      agent.state.messages = [
        ...agent.state.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: "Profile setup complete." }],
          timestamp: Date.now(),
        },
      ];
    };

    const loop = new AgentLoop(bus, persistence, config);
    await loop.start();
    startedLoops.push(loop);

    bus.publishInbound({
      message: {
        role: "user",
        content: "hello",
        timestamp: Date.now(),
      },
      channel: "cli",
      userId: "user-1",
    });

    await waitFor(
      async () => (await taskService.listJobs("active")).length === 1,
    );
    const activeJob = (await taskService.listJobs("active"))[0];
    expect(activeJob.kind).toBe("onboarding");
    expect(outbound[0]).toContain("Complete user profile");

    bus.publishInbound({
      message: {
        role: "user",
        content: "continue",
        timestamp: Date.now(),
      },
      channel: "cli",
      userId: "user-1",
    });

    await waitFor(
      async () => (await taskService.listJobs("archived")).length === 1,
    );
    expect(await taskService.listJobs("active")).toHaveLength(0);
    expect((await taskService.listJobs("archived"))[0].status).toBe(
      "completed",
    );

    const profile = await profileService.getProfile();
    expect(profile.setupComplete).toBe(true);
    expect(profile.defaultCalendar).toBe("primary");
  });
});

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

  throw new Error("Timed out waiting for condition");
}
