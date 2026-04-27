import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildSystemPrompt,
  BuildSystemPromptOptions,
} from "../src/agent/context";
import { MemoryStore } from "../src/services/memory";
import { promises as fs } from "node:fs";

// Mock fs module
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
    it("should build system prompt with all components", async () => {
      const mockSummary = "Previous conversation about project setup";
      const mockBootstrap = "## AGENTS.md\n\nAgent instructions";
      const mockSkillsSummary = "- **calendar**: Manage calendar events";

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(mockSummary)
        .mockResolvedValueOnce(mockBootstrap);

      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        threadPath: "/test/threads/thread1",
        channel: "cli",
        summary: mockSummary,
        skillsSummary: mockSkillsSummary,
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain("## Conversation Summary");
      expect(prompt).toContain(mockSummary);
      expect(prompt).toContain("## Format Hint");
      expect(prompt).toContain("## AGENTS.md");
      expect(prompt).toContain("## Available Skills");
      expect(prompt).toContain(mockSkillsSummary);
    });

    it("should include memory context when memory store is provided", async () => {
      const mockMemoryStore = {
        getMemoryContext: vi
          .fn()
          .mockResolvedValue("## Long-term Memory\n\nUser prefers dark mode"),
      } as unknown as MemoryStore;

      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        memoryStore: mockMemoryStore,
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain("## Long-term Memory");
      expect(prompt).toContain("User prefers dark mode");
    });

    it("should not include memory context when no memories exist", async () => {
      const mockMemoryStore = {
        getMemoryContext: vi.fn().mockResolvedValue(null),
      } as unknown as MemoryStore;

      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        memoryStore: mockMemoryStore,
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).not.toContain("## Long-term Memory");
    });

    it("should read summary from file when threadPath is provided", async () => {
      const mockSummary = "Conversation summary from file";
      vi.mocked(fs.readFile).mockResolvedValue(mockSummary);

      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        threadPath: "/test/threads/thread1",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain("## Conversation Summary");
      expect(prompt).toContain(mockSummary);
    });

    it("should use provided summary over file summary", async () => {
      const mockSummary = "Provided summary";
      const mockBootstrap = "## AGENTS.md\n\nContent";

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(mockBootstrap) // First call is for AGENTS.md
        .mockResolvedValueOnce(mockBootstrap) // Second call for GOALS.md
        .mockResolvedValueOnce(mockBootstrap) // Third call for SOUL.md
        .mockResolvedValueOnce(mockBootstrap) // Fourth call for USER.md
        .mockResolvedValueOnce(mockBootstrap); // Fifth call for TOOLS.md

      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        threadPath: "/test/threads/thread1",
        summary: mockSummary,
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain(mockSummary);
      // The file summary should not appear in the prompt
      expect(prompt).not.toContain("File summary");
    });

    it("should handle missing summary gracefully", async () => {
      const mockBootstrap = "## AGENTS.md\n\nContent";

      vi.mocked(fs.readFile)
        .mockRejectedValueOnce({ code: "ENOENT" }) // First call is for summary file
        .mockResolvedValueOnce(mockBootstrap) // Second call is for AGENTS.md
        .mockResolvedValueOnce(mockBootstrap) // Third call for GOALS.md
        .mockResolvedValueOnce(mockBootstrap) // Fourth call for SOUL.md
        .mockResolvedValueOnce(mockBootstrap) // Fifth call for USER.md
        .mockResolvedValueOnce(mockBootstrap); // Sixth call for TOOLS.md

      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        threadPath: "/test/threads/thread1",
      };

      const prompt = await buildSystemPrompt(options);

      // When summary file doesn't exist, no summary section should be added
      expect(prompt).not.toContain("## Conversation Summary");
    });

    it("should include format hint for CLI channel", async () => {
      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        channel: "cli",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain("## Format Hint");
      expect(prompt).toContain("terminal");
    });

    it("should include format hint for Telegram channel", async () => {
      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        channel: "telegram",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain("## Format Hint");
      expect(prompt).toContain("messaging app");
    });

    it("should include format hint for email channel", async () => {
      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        channel: "email",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain("## Format Hint");
      expect(prompt).toContain("email");
    });

    it("should not include format hint for unknown channel", async () => {
      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        channel: "unknown",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).not.toContain("## Format Hint");
    });

    it("should load bootstrap files from workspace", async () => {
      const mockAgents = "## AGENTS.md\n\nAgent instructions";
      const mockGoals = "## GOALS.md\n\nProject goals";
      const mockSoul = "## SOUL.md\n\nAgent personality";
      const mockUser = "## USER.md\n\nUser preferences";
      const mockTools = "## TOOLS.md\n\nTool usage";

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(mockAgents)
        .mockResolvedValueOnce(mockGoals)
        .mockResolvedValueOnce(mockSoul)
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValueOnce(mockTools);

      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain("## AGENTS.md");
      expect(prompt).toContain("## GOALS.md");
      expect(prompt).toContain("## SOUL.md");
      expect(prompt).toContain("## USER.md");
      expect(prompt).toContain("## TOOLS.md");
    });

    it("should handle missing bootstrap files gracefully", async () => {
      vi.mocked(fs.readFile).mockRejectedValue({ code: "ENOENT" });

      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).not.toContain("## AGENTS.md");
    });

    it("should include skills summary when provided", async () => {
      const mockSkillsSummary =
        "- **calendar**: Manage calendar events\n- **planning**: Plan tasks";

      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        skillsSummary: mockSkillsSummary,
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain("## Available Skills");
      expect(prompt).toContain(mockSkillsSummary);
    });

    it("should separate sections with ---", async () => {
      const mockSummary = "Summary";
      const mockBootstrap = "## AGENTS.md\n\nContent";
      const mockSkillsSummary = "- **skill**: Description";

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(mockSummary)
        .mockResolvedValueOnce(mockBootstrap);

      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        threadPath: "/test/threads/thread1",
        channel: "cli",
        skillsSummary: mockSkillsSummary,
      };

      const prompt = await buildSystemPrompt(options);

      const separatorCount = (prompt.match(/---/g) || []).length;
      expect(separatorCount).toBeGreaterThanOrEqual(2);
    });

    it("should handle minimal options", async () => {
      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
      };

      const prompt = await buildSystemPrompt(options);

      expect(typeof prompt).toBe("string");
    });

    it("should handle all options provided", async () => {
      const mockMemoryStore = {
        getMemoryContext: vi
          .fn()
          .mockResolvedValue("## Long-term Memory\n\nMemory content"),
      } as unknown as MemoryStore;

      const mockSummary = "Summary";
      const mockBootstrap = "## AGENTS.md\n\nContent";
      const mockSkillsSummary = "- **skill**: Description";

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(mockSummary)
        .mockResolvedValueOnce(mockBootstrap);

      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        threadPath: "/test/threads/thread1",
        channel: "cli",
        summary: mockSummary,
        skillsSummary: mockSkillsSummary,
        memoryStore: mockMemoryStore,
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain("## Conversation Summary");
      expect(prompt).toContain("## Long-term Memory");
      expect(prompt).toContain("## Format Hint");
      expect(prompt).toContain("## AGENTS.md");
      expect(prompt).toContain("## Available Skills");
    });
  });

  describe("format hints", () => {
    it("should provide correct format hint for telegram", async () => {
      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        channel: "telegram",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain("short paragraphs");
      expect(prompt).toContain("Avoid tables");
    });

    it("should provide correct format hint for discord", async () => {
      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        channel: "discord",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain("short paragraphs");
    });

    it("should provide correct format hint for whatsapp", async () => {
      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        channel: "whatsapp",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain("plain text only");
    });

    it("should provide correct format hint for sms", async () => {
      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        channel: "sms",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain("plain text only");
    });

    it("should provide correct format hint for mochat", async () => {
      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        channel: "mochat",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain("terminal");
      expect(prompt).toContain("Avoid markdown headings");
    });
  });

  describe("edge cases", () => {
    it("should handle empty summary", async () => {
      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        summary: "",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).not.toContain("## Conversation Summary");
    });

    it("should handle empty skills summary", async () => {
      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        skillsSummary: "",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).not.toContain("## Available Skills");
    });

    it("should handle very long summary", async () => {
      const longSummary = "A".repeat(10000);
      vi.mocked(fs.readFile).mockResolvedValue(longSummary);

      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        threadPath: "/test/threads/thread1",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain(longSummary);
    });

    it("should handle special characters in summary", async () => {
      const specialSummary = "Summary with <>&\"' special chars";
      vi.mocked(fs.readFile).mockResolvedValue(specialSummary);

      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        threadPath: "/test/threads/thread1",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain(specialSummary);
    });

    it("should handle unicode characters in summary", async () => {
      const unicodeSummary = "Summary with 你好 🎉 emojis";
      vi.mocked(fs.readFile).mockResolvedValue(unicodeSummary);

      const options: BuildSystemPromptOptions = {
        workspacePath: "/test/workspace",
        threadPath: "/test/threads/thread1",
      };

      const prompt = await buildSystemPrompt(options);

      expect(prompt).toContain(unicodeSummary);
    });
  });
});
