import { beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import {
  buildSystemPrompt,
  type BuildSystemPromptOptions,
} from "../src/agent/context";

vi.mock("node:fs", () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

describe("Context Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("buildSystemPrompt", () => {
    it("builds the prompt from summary, bootstrap files, filtered memory surfaces, retrieval, and skills", async () => {
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce("Conversation summary from file")
        .mockResolvedValueOnce("Agent instructions")
        .mockResolvedValueOnce("Tone and style")
        .mockResolvedValueOnce("Tool usage");

      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        threadPath: "/test/threads/thread1",
        channel: "cli",
        skillsSummary: "- gws-calendar-agenda: show upcoming events",
        userProfileService: {
          getPromptContext: vi.fn().mockResolvedValue(`## USER.md

### Managed Profile
- timezone: Asia/Saigon
### Preferences
- Prefers morning meetings when possible.`),
        } as any,
        goalService: {
          getPromptContext: vi.fn().mockResolvedValue(`## GOALS.md

### Active Goals
- Finish thesis draft [on-track]`),
        } as any,
        taskService: {
          getPromptContext: vi.fn().mockResolvedValue(`## TASKS.md

### Active Jobs
- Confirm plan: schedule "Deep work block"`),
        } as any,
        memoryService: {
          getPromptContext: vi.fn().mockResolvedValue(`## MEMORY.md

### Decisions
- Use gws for Google Calendar execution.`),
        } as any,
        relevantMemory: `## Relevant Memory

- (decision) Use gws for Google Calendar execution. [gws]`,
        relevantHistory: `## Relevant Prior Conversation

- user: Last time we scheduled this in the morning.`,
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain("## Runtime");
      expect(prompt).toContain("## Workspace");
      expect(prompt).toContain("## Task Policy");
      expect(prompt).toContain("## Search & Discovery");
      expect(prompt).toContain("## Conversation Summary");
      expect(prompt).toContain("## Format Hint");
      expect(prompt).toContain("## AGENTS.md");
      expect(prompt).toContain("## SOUL.md");
      expect(prompt).toContain("## TOOLS.md");
      expect(prompt).toContain("## USER.md");
      expect(prompt).toContain("## GOALS.md");
      expect(prompt).toContain("## TASKS.md");
      expect(prompt).toContain("## MEMORY.md");
      expect(prompt).toContain("## Relevant Memory");
      expect(prompt).toContain("## Relevant Prior Conversation");
      expect(prompt).toContain("## Available Skills");
      expect(prompt).toContain("Prefers morning meetings when possible.");
      expect(prompt).not.toContain("## Long-term Memory");
    });

    it("uses only static bootstrap files by default", async () => {
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce("Agent instructions")
        .mockResolvedValueOnce("Tone and style")
        .mockResolvedValueOnce("Tool usage");

      const prompt = await buildSystemPrompt({
        workspacePath: "/test/workspace",
      });

      expect(prompt).toContain("## Runtime");
      expect(prompt).toContain("## Workspace");
      expect(prompt).toContain("## Task Policy");
      expect(prompt).toContain("## Search & Discovery");
      expect(prompt).toContain("## AGENTS.md");
      expect(prompt).toContain("## SOUL.md");
      expect(prompt).toContain("## TOOLS.md");
      expect(prompt).not.toContain("## USER.md");
      expect(prompt).not.toContain("## GOALS.md");
      expect(prompt).not.toContain("## TASKS.md");
      expect(prompt).not.toContain("## MEMORY.md");
    });

    it("handles missing summary and bootstrap files gracefully", async () => {
      vi.mocked(fs.readFile).mockRejectedValue({ code: "ENOENT" });

      const prompt = await buildSystemPrompt({
        workspacePath: "/test/workspace",
        threadPath: "/test/threads/thread1",
      });

      expect(prompt).toContain("## Runtime");
      expect(prompt).not.toContain("## Conversation Summary");
      expect(prompt).not.toContain("## AGENTS.md");
    });

    it("includes the appropriate format hint for messaging channels", async () => {
      const prompt = await buildSystemPrompt({
        workspacePath: "/test/workspace",
        channel: "telegram",
      });

      expect(prompt).toContain("messaging app");
      expect(prompt).toContain("Avoid tables");
    });

    it("omits empty skills summaries", async () => {
      const prompt = await buildSystemPrompt({
        workspacePath: "/test/workspace",
        skillsSummary: "",
      });

      expect(prompt).not.toContain("## Available Skills");
    });
  });
});
