import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DreamService, type AgentMessage } from "../src/agent/dream";
import { GoalService } from "../src/services/goals";
import { UserProfileService } from "../src/services/user_profile";
import { WorkspaceMemoryService } from "../src/services/workspace_memory";

describe("DreamService", () => {
  let tempDir: string;
  let userProfileService: UserProfileService;
  let goalService: GoalService;
  let workspaceMemoryService: WorkspaceMemoryService;
  let dreamService: DreamService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "miniclaw-dream-"));
    userProfileService = new UserProfileService(tempDir);
    goalService = new GoalService(tempDir);
    workspaceMemoryService = new WorkspaceMemoryService(tempDir);
    await userProfileService.ensureProfileFile();
    await goalService.ensureGoalsFile();
    await workspaceMemoryService.ensureMemoryFile();
    dreamService = new DreamService(
      userProfileService,
      goalService,
      workspaceMemoryService,
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not consolidate below the minimum message threshold", async () => {
    const result = await dreamService.consolidate([
      message("user", "hello", 1),
      message("assistant", "hi", 2),
    ]);

    expect(result).toEqual({
      addedPreferences: [],
      addedFacts: [],
      memoryEntriesRecorded: [],
      goalUpdates: [],
    });
  });

  it("writes extracted preferences and facts into USER.md", async () => {
    const result = await dreamService.consolidate([
      message("user", "I prefer deep work blocks in the morning", 1),
      message("assistant", "Noted", 2),
      message("user", "My name is Lan", 3),
      message("assistant", "Got it", 4),
      message("user", "I like short summaries", 5),
    ]);

    const document = await userProfileService.getDocument();

    expect(result.addedPreferences).toEqual(
      expect.arrayContaining([
        "deep work blocks in the morning",
        "short summaries",
      ]),
    );
    expect(document.preferences).toEqual(
      expect.arrayContaining([
        "deep work blocks in the morning",
        "short summaries",
      ]),
    );
    expect(document.stableFacts).toEqual(
      expect.arrayContaining(["My name is Lan"]),
    );
  });

  it("records workspace memory entries instead of behavioral observations", async () => {
    const result = await dreamService.consolidate([
      message("user", "We decided to use gws for Google Calendar execution.", 1),
      message("assistant", "Noted", 2),
      message("user", "This workflow worked well for weekly planning.", 3),
      message("assistant", "Good", 4),
      message("user", "I prefer short summaries.", 5),
    ]);

    const memoryEntries = await workspaceMemoryService.listEntries();
    const promptContext = await userProfileService.getPromptContext();

    expect(result.memoryEntriesRecorded).toEqual(
      expect.arrayContaining([
        "We decided to use gws for Google Calendar execution.",
        "This workflow worked well for weekly planning.",
      ]),
    );
    expect(memoryEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "decision" }),
        expect.objectContaining({ category: "attempt_outcome" }),
      ]),
    );
    expect(promptContext).not.toContain("Behavioral Observations");
  });

  it("records progress when a message references an active goal", async () => {
    const goal = await goalService.addGoal({
      title: "Finish thesis draft",
      rationale: "Graduate on time",
    });

    const result = await dreamService.consolidate([
      message("user", "Today I made progress on finish thesis draft", 1),
      message("assistant", "Good", 2),
      message("user", "Still working on finish thesis draft", 3),
      message("assistant", "Keep going", 4),
      message("user", "I prefer structured outlines", 5),
    ]);

    const updatedGoal = await goalService.getGoal(goal.id);
    expect(result.goalUpdates).toContain(goal.id);
    expect(updatedGoal?.progress.length).toBeGreaterThan(0);
    expect(updatedGoal?.evidence[0]).toContain("finish thesis draft");
  });
});

function message(
  role: "user" | "assistant" | "system",
  content: string,
  timestamp: number,
): AgentMessage {
  return {
    id: `msg-${timestamp}`,
    role,
    content,
    timestamp,
  };
}
