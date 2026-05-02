import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoalService } from "../src/services/goals";

describe("GoalService", () => {
  let tempDir: string;
  let workspaceDir: string;
  let goalService: GoalService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "miniclaw-goals-"));
    workspaceDir = path.join(tempDir, "workspace");
    goalService = new GoalService(workspaceDir);
    await goalService.ensureGoalsFile();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("adds explicit goals and records progress without inventing extra entries", async () => {
    const created = await goalService.addGoal({
      title: "Finish thesis chapter 3",
      rationale: "It is the next milestone for the report.",
      deadline: "2026-05-10",
      timeHorizon: "this week",
    });
    const updated = await goalService.recordProgress({
      goalId: created.id,
      summary: "Drafted the methodology section.",
      source: "manual",
      linkedTaskId: "job_123",
    });

    const activeGoals = await goalService.listGoals("active");

    expect(activeGoals).toHaveLength(1);
    expect(activeGoals[0].id).toBe(created.id);
    expect(updated.progress).toHaveLength(1);
    expect(updated.linkedTaskIds).toContain("job_123");
    expect(updated.evidence).toContain("Drafted the methodology section.");
  });

  it("summarizes active goals for prompt construction and archives completed ones", async () => {
    const goal = await goalService.addGoal({
      title: "Maintain exercise routine",
      rationale: "Protect energy and focus during thesis season.",
      timeHorizon: "this month",
    });
    await goalService.recordProgress({
      goalId: goal.id,
      summary: "Completed three workouts this week.",
    });

    const prompt = await goalService.getPromptContext();
    const archived = await goalService.updateStatus(goal.id, "completed");
    const archivedGoals = await goalService.listGoals("archived");

    expect(prompt).toContain("## GOALS.md");
    expect(prompt).toContain("Maintain exercise routine [active]");
    expect(prompt).toContain(
      "Latest progress: Completed three workouts this week.",
    );
    expect(archived.status).toBe("completed");
    expect(archivedGoals.map((entry) => entry.id)).toContain(goal.id);
  });

  it("recovers cleanly from malformed managed sections", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "GOALS.md"),
      `# GOALS.md

## Active Goals
<!-- miniclaw:active-goals:start -->
\`\`\`json
{not valid json}
\`\`\`
<!-- miniclaw:active-goals:end -->

## Archived Goals
<!-- miniclaw:archived-goals:start -->
\`\`\`json
[]
\`\`\`
<!-- miniclaw:archived-goals:end -->
`,
      "utf8",
    );

    expect(await goalService.listGoals("active")).toEqual([]);

    const goal = await goalService.addGoal({
      title: "Recover from malformed file",
      rationale: "The parser should fall back instead of crashing.",
    });

    expect(goal.title).toBe("Recover from malformed file");
    expect(await goalService.getGoal(goal.id)).not.toBeNull();
  });
});
