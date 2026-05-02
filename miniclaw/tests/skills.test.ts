import { describe, it, expect, beforeEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SkillsLoader } from "../src/agent/skills";

// Mock fs module
vi.mock("node:fs", () => ({
  promises: {
    readdir: vi.fn(),
    readFile: vi.fn(),
  },
}));

describe("SkillsLoader", () => {
  let skillsLoader: SkillsLoader;
  const mockSkillsPath = "/test/skills";

  beforeEach(() => {
    skillsLoader = new SkillsLoader(mockSkillsPath);
    vi.clearAllMocks();
  });

  describe("listSkills", () => {
    it("should list all skills in directory", async () => {
      const mockEntries = [
        { name: "calendar", isDirectory: () => true },
        { name: "planning", isDirectory: () => true },
      ];

      const mockCalendarSkill = `---
name: calendar
description: Manage calendar events
triggers: ["calendar", "event"]
---

# Calendar

Use this skill to manage your calendar events.
`;

      const mockPlanningSkill = `---
name: planning
description: Plan tasks and projects
---

# Planning

Use this skill to plan your tasks and projects.
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(mockCalendarSkill)
        .mockResolvedValueOnce(mockPlanningSkill);

      const skills = await skillsLoader.listSkills();

      expect(skills).toHaveLength(2);
      expect(skills[0].name).toBe("calendar");
      expect(skills[1].name).toBe("planning");
    });

    it("should parse skill metadata from frontmatter", async () => {
      const mockEntries = [{ name: "test", isDirectory: () => true }];

      const mockSkill = `---
name: test-skill
description: Test skill description
triggers: ["test", "trigger"]
always: true
---

# Test Skill

This is a test skill.
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile).mockResolvedValue(mockSkill);

      const skills = await skillsLoader.listSkills();

      expect(skills[0].name).toBe("test");
      expect(skills[0].description).toBe("Test skill description");
      expect(skills[0].triggers).toEqual(["test", "trigger"]);
      expect(skills[0].always).toBe(true);
    });

    it("should handle skills without frontmatter", async () => {
      const mockEntries = [{ name: "simple", isDirectory: () => true }];

      const mockSkill = `# Simple Skill

This is a simple skill without frontmatter.
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile).mockResolvedValue(mockSkill);

      const skills = await skillsLoader.listSkills();

      expect(skills[0].name).toBe("simple");
      expect(skills[0].description).toBe("Simple Skill");
      expect(skills[0].triggers).toBeUndefined();
      // always field defaults to false when not specified
      expect(skills[0].always).toBe(false);
    });

    it("should skip non-directory entries", async () => {
      const mockEntries = [
        { name: "calendar", isDirectory: () => true },
        { name: "README.md", isDirectory: () => false },
      ];

      const mockCalendarSkill = `---
name: calendar
description: Manage calendar events
---

# Calendar
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile).mockResolvedValue(mockCalendarSkill);

      const skills = await skillsLoader.listSkills();

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("calendar");
    });

    it("should handle missing SKILL.md files gracefully", async () => {
      const mockEntries = [
        { name: "valid", isDirectory: () => true },
        { name: "invalid", isDirectory: () => true },
      ];

      const mockValidSkill = `---
name: valid
description: Valid skill
---

# Valid
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(mockValidSkill)
        .mockRejectedValueOnce(new Error("File not found"));

      const skills = await skillsLoader.listSkills();

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("valid");
    });

    it("should cache skills list", async () => {
      const mockEntries = [{ name: "test", isDirectory: () => true }];

      const mockSkill = `---
name: test
description: Test skill
---

# Test
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile).mockResolvedValue(mockSkill);

      await skillsLoader.listSkills();
      await skillsLoader.listSkills();

      expect(fs.readdir).toHaveBeenCalledTimes(1);
    });

    it("should clear cache when clearCache is called", async () => {
      const mockEntries = [{ name: "test", isDirectory: () => true }];

      const mockSkill = `---
name: test
description: Test skill
---

# Test
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile).mockResolvedValue(mockSkill);

      await skillsLoader.listSkills();
      skillsLoader.clearCache();
      await skillsLoader.listSkills();

      expect(fs.readdir).toHaveBeenCalledTimes(2);
    });

    it("should handle empty skills directory", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);

      const skills = await skillsLoader.listSkills();

      expect(skills).toEqual([]);
    });

    it("should handle readdir errors", async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error("Permission denied"));

      const skills = await skillsLoader.listSkills();

      expect(skills).toEqual([]);
    });
  });

  describe("loadSkill", () => {
    it("should load skill content", async () => {
      const mockSkill = `---
name: test
description: Test skill
---

# Test Skill

This is the content of the test skill.
`;

      vi.mocked(fs.readFile).mockResolvedValue(mockSkill);

      const content = await skillsLoader.loadSkill("test");

      expect(content).toContain("# Test Skill");
      expect(content).toContain("This is the content of the test skill.");
      expect(content).not.toContain("---");
    });

    it("should remove frontmatter from content", async () => {
      const mockSkill = `---
name: test
description: Test skill
---

# Test Skill

Content here.
`;

      vi.mocked(fs.readFile).mockResolvedValue(mockSkill);

      const content = await skillsLoader.loadSkill("test");

      expect(content).not.toContain("name: test");
      expect(content).not.toContain("description: Test skill");
    });

    it("should return null when skill file not found", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("File not found"));

      const content = await skillsLoader.loadSkill("nonexistent");

      expect(content).toBeNull();
    });

    it("should handle skill without frontmatter", async () => {
      const mockSkill = `# Test Skill

Content here.
`;

      vi.mocked(fs.readFile).mockResolvedValue(mockSkill);

      const content = await skillsLoader.loadSkill("test");

      expect(content).toContain("# Test Skill");
    });
  });

  describe("getSkillSummary", () => {
    it("should return summary of all skills", async () => {
      const mockEntries = [
        { name: "calendar", isDirectory: () => true },
        { name: "planning", isDirectory: () => true },
      ];

      const mockCalendarSkill = `---
name: calendar
description: Manage calendar events
triggers: ["calendar", "event"]
---

# Calendar
`;

      const mockPlanningSkill = `---
name: planning
description: Plan tasks and projects
triggers: ["plan", "task"]
---

# Planning
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(mockCalendarSkill)
        .mockResolvedValueOnce(mockPlanningSkill);

      const summary = await skillsLoader.getSkillSummary();

      expect(summary).toContain("**calendar**: Manage calendar events");
      expect(summary).toContain("(triggers: calendar, event)");
      expect(summary).toContain("**planning**: Plan tasks and projects");
      expect(summary).toContain("(triggers: plan, task)");
    });

    it("should exclude always skills from summary", async () => {
      const mockEntries = [
        { name: "always-skill", isDirectory: () => true },
        { name: "on-demand", isDirectory: () => true },
      ];

      const mockAlwaysSkill = `---
name: always-skill
description: Always loaded skill
always: true
---

# Always
`;

      const mockOnDemandSkill = `---
name: on-demand
description: On-demand skill
---

# On-demand
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(mockAlwaysSkill)
        .mockResolvedValueOnce(mockOnDemandSkill);

      const summary = await skillsLoader.getSkillSummary();

      expect(summary).not.toContain("always-skill");
      expect(summary).toContain("**on-demand**: ---");
      expect(summary).toContain("description: On-demand skill");
    });

    it("should return message when no skills available", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);

      const summary = await skillsLoader.getSkillSummary();

      expect(summary).toBe("No on-demand skills available.");
    });

    it("should handle skills without triggers", async () => {
      const mockEntries = [{ name: "test", isDirectory: () => true }];

      const mockSkill = `---
name: test
description: Test skill
---

# Test
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile).mockResolvedValue(mockSkill);

      const summary = await skillsLoader.getSkillSummary();

      expect(summary).toContain("**test**: ---");
      expect(summary).toContain("description: Test skill");
      expect(summary).not.toContain("(triggers:");
    });

    it("should parse CRLF frontmatter and keep non-trigger skills to frontmatter only", async () => {
      const mockEntries = [
        { name: "calendar", isDirectory: () => true },
        { name: "gws-calendar", isDirectory: () => true },
      ];

      const mockCalendarSkill =
        '---\r\nname: calendar\r\ndescription: Manage calendar events\r\ntriggers: ["calendar", "event"]\r\n---\r\n\r\n# Calendar\r\n';
      const mockGwsSkill =
        '---\r\nname: gws-calendar\r\ndescription: "Google Calendar: Manage calendars and events."\r\nmetadata:\r\n  version: 0.22.5\r\n---\r\n\r\n# calendar\r\n\r\nFull body should not appear.\r\n';

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(mockCalendarSkill)
        .mockResolvedValueOnce(mockGwsSkill);

      const summary = await skillsLoader.getSkillSummary();

      expect(summary).toContain(
        "**calendar**: Manage calendar events (triggers: calendar, event)",
      );
      expect(summary).toContain("**gws-calendar**: ---");
      expect(summary).toContain(
        'description: "Google Calendar: Manage calendars and events."',
      );
      expect(summary).not.toContain("Full body should not appear.");
    });
  });

  describe("getAlwaysSkills", () => {
    it("should return skills marked with always: true", async () => {
      const mockEntries = [
        { name: "always1", isDirectory: () => true },
        { name: "always2", isDirectory: () => true },
        { name: "on-demand", isDirectory: () => true },
      ];

      const mockAlways1Skill = `---
name: always1
description: Always skill 1
always: true
---

# Always 1
`;

      const mockAlways2Skill = `---
name: always2
description: Always skill 2
always: true
---

# Always 2
`;

      const mockOnDemandSkill = `---
name: on-demand
description: On-demand skill
---

# On-demand
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(mockAlways1Skill)
        .mockResolvedValueOnce(mockAlways2Skill)
        .mockResolvedValueOnce(mockOnDemandSkill);

      const alwaysSkills = await skillsLoader.getAlwaysSkills();

      expect(alwaysSkills).toHaveLength(2);
      expect(alwaysSkills[0].name).toBe("always1");
      expect(alwaysSkills[1].name).toBe("always2");
    });

    it("should return empty array when no always skills", async () => {
      const mockEntries = [{ name: "on-demand", isDirectory: () => true }];

      const mockOnDemandSkill = `---
name: on-demand
description: On-demand skill
---

# On-demand
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile).mockResolvedValue(mockOnDemandSkill);

      const alwaysSkills = await skillsLoader.getAlwaysSkills();

      expect(alwaysSkills).toEqual([]);
    });

    it("should handle always: false", async () => {
      const mockEntries = [{ name: "test", isDirectory: () => true }];

      const mockSkill = `---
name: test
description: Test skill
always: false
---

# Test
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile).mockResolvedValue(mockSkill);

      const alwaysSkills = await skillsLoader.getAlwaysSkills();

      expect(alwaysSkills).toEqual([]);
    });

    it("should handle always: 1 (numeric true)", async () => {
      const mockEntries = [{ name: "test", isDirectory: () => true }];

      const mockSkill = `---
name: test
description: Test skill
always: 1
---

# Test
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile).mockResolvedValue(mockSkill);

      const alwaysSkills = await skillsLoader.getAlwaysSkills();

      expect(alwaysSkills).toHaveLength(1);
      expect(alwaysSkills[0].always).toBe(true);
    });
  });

  describe("loadSkillsForContext", () => {
    it("should load multiple skills for context", async () => {
      const mockSkill1 = `---
name: skill1
description: Skill 1
---

# Skill 1

Content of skill 1.
`;

      const mockSkill2 = `---
name: skill2
description: Skill 2
---

# Skill 2

Content of skill 2.
`;

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(mockSkill1)
        .mockResolvedValueOnce(mockSkill2);

      const content = await skillsLoader.loadSkillsForContext([
        "skill1",
        "skill2",
      ]);

      expect(content).toContain("### Skill: skill1");
      expect(content).toContain("Content of skill 1.");
      expect(content).toContain("### Skill: skill2");
      expect(content).toContain("Content of skill 2.");
    });

    it("should separate skills with double newlines", async () => {
      const mockSkill1 = `---
name: skill1
description: Skill 1
---

# Skill 1
`;

      const mockSkill2 = `---
name: skill2
description: Skill 2
---

# Skill 2
`;

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(mockSkill1)
        .mockResolvedValueOnce(mockSkill2);

      const content = await skillsLoader.loadSkillsForContext([
        "skill1",
        "skill2",
      ]);

      expect(content).toContain("### Skill: skill1");
      expect(content).toContain("# Skill 1");
      expect(content).toContain("### Skill: skill2");
      expect(content).toContain("# Skill 2");
      expect(content).toContain("\n\n### Skill: skill2");
    });

    it("should handle missing skills gracefully", async () => {
      const mockSkill1 = `---
name: skill1
description: Skill 1
---

# Skill 1
`;

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(mockSkill1)
        .mockRejectedValueOnce(new Error("Not found"));

      const content = await skillsLoader.loadSkillsForContext([
        "skill1",
        "skill2",
      ]);

      expect(content).toContain("### Skill: skill1");
      expect(content).not.toContain("### Skill: skill2");
    });

    it("should handle empty skill list", async () => {
      const content = await skillsLoader.loadSkillsForContext([]);

      expect(content).toBe("");
    });
  });

  describe("getSkillInfo", () => {
    it("should return skill metadata for specific skill", async () => {
      const mockEntries = [
        { name: "calendar", isDirectory: () => true },
        { name: "planning", isDirectory: () => true },
      ];

      const mockCalendarSkill = `---
name: calendar
description: Manage calendar events
triggers: ["calendar", "event"]
---

# Calendar
`;

      const mockPlanningSkill = `---
name: planning
description: Plan tasks
---

# Planning
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(mockCalendarSkill)
        .mockResolvedValueOnce(mockPlanningSkill);

      const info = await skillsLoader.getSkillInfo("calendar");

      expect(info).not.toBeNull();
      expect(info?.name).toBe("calendar");
      expect(info?.description).toBe("Manage calendar events");
      expect(info?.triggers).toEqual(["calendar", "event"]);
    });

    it("should return null for non-existent skill", async () => {
      const mockEntries = [{ name: "calendar", isDirectory: () => true }];

      const mockCalendarSkill = `---
name: calendar
description: Manage calendar events
---

# Calendar
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile).mockResolvedValue(mockCalendarSkill);

      const info = await skillsLoader.getSkillInfo("nonexistent");

      expect(info).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("should handle malformed frontmatter", async () => {
      const mockEntries = [{ name: "malformed", isDirectory: () => true }];

      const mockSkill = `---
name: malformed
description: "Unclosed quote
---

# Malformed
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile).mockResolvedValue(mockSkill);

      const skills = await skillsLoader.listSkills();

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("malformed");
    });

    it("should handle empty triggers array", async () => {
      const mockEntries = [{ name: "test", isDirectory: () => true }];

      const mockSkill = `---
name: test
description: Test skill
triggers: []
---

# Test
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile).mockResolvedValue(mockSkill);

      const skills = await skillsLoader.listSkills();

      expect(skills[0].triggers).toBeUndefined();
    });

    it("should handle skill with only frontmatter", async () => {
      const mockEntries = [{ name: "minimal", isDirectory: () => true }];

      const mockSkill = `---
name: minimal
description: Minimal skill
---
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile).mockResolvedValue(mockSkill);

      const skills = await skillsLoader.listSkills();

      expect(skills[0].description).toBe("Minimal skill");
    });

    it("should handle skill name with special characters", async () => {
      const mockEntries = [{ name: "test-skill_v2", isDirectory: () => true }];

      const mockSkill = `---
name: test-skill_v2
description: Test skill v2
---

# Test
`;

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile).mockResolvedValue(mockSkill);

      const skills = await skillsLoader.listSkills();

      expect(skills[0].name).toBe("test-skill_v2");
    });
  });
});
