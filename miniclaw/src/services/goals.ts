import { promises as fs } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

const ACTIVE_START = "<!-- miniclaw:active-goals:start -->";
const ACTIVE_END = "<!-- miniclaw:active-goals:end -->";
const ARCHIVED_START = "<!-- miniclaw:archived-goals:start -->";
const ARCHIVED_END = "<!-- miniclaw:archived-goals:end -->";

export type GoalSection = "active" | "archived";
export type GoalStatus =
  | "active"
  | "on-track"
  | "at-risk"
  | "stalled"
  | "completed"
  | "cancelled";

export interface GoalProgressRecord {
  at: string;
  summary: string;
  source?: string;
  linkedTaskId?: string;
}

export interface GoalRecord {
  id: string;
  title: string;
  rationale: string;
  status: GoalStatus;
  deadline?: string;
  timeHorizon?: string;
  progress: GoalProgressRecord[];
  evidence: string[];
  linkedTaskIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface GoalsFileData {
  active: GoalRecord[];
  archived: GoalRecord[];
}

export interface AddGoalInput {
  title: string;
  rationale: string;
  deadline?: string;
  timeHorizon?: string;
}

export interface RecordGoalProgressInput {
  goalId: string;
  summary: string;
  source?: string;
  linkedTaskId?: string;
}

export class GoalService {
  constructor(private readonly workspacePath: string) {}

  public get goalsPath(): string {
    return path.join(this.workspacePath, "GOALS.md");
  }

  public async ensureGoalsFile(): Promise<void> {
    try {
      await fs.access(this.goalsPath);
    } catch {
      await fs.mkdir(this.workspacePath, { recursive: true });
      await fs.writeFile(
        this.goalsPath,
        renderGoalsMarkdown(emptyGoalsFile()),
        "utf8",
      );
    }
  }

  public async listGoals(section?: GoalSection): Promise<GoalRecord[]> {
    const data = await this.readGoals();
    if (!section) {
      return [...data.active, ...data.archived];
    }
    return [...data[section]];
  }

  public async getGoal(goalId: string): Promise<GoalRecord | null> {
    const data = await this.readGoals();
    return (
      data.active.find((goal) => goal.id === goalId) ||
      data.archived.find((goal) => goal.id === goalId) ||
      null
    );
  }

  public async addGoal(input: AddGoalInput): Promise<GoalRecord> {
    const data = await this.readGoals();
    const now = new Date().toISOString();
    const goal: GoalRecord = {
      id: `goal_${ulid().toLowerCase()}`,
      title: input.title.trim(),
      rationale: input.rationale.trim(),
      status: "active",
      deadline: input.deadline?.trim() || undefined,
      timeHorizon: input.timeHorizon?.trim() || undefined,
      progress: [],
      evidence: [],
      linkedTaskIds: [],
      createdAt: now,
      updatedAt: now,
    };

    data.active.push(goal);
    await this.writeGoals(data);
    return goal;
  }

  public async recordProgress(
    input: RecordGoalProgressInput,
  ): Promise<GoalRecord> {
    const data = await this.readGoals();
    const goal = requireGoal(data, input.goalId);
    const now = new Date().toISOString();
    const summary = input.summary.trim();

    if (summary) {
      goal.progress.push({
        at: now,
        summary,
        source: input.source?.trim() || undefined,
        linkedTaskId: input.linkedTaskId?.trim() || undefined,
      });
      pushUnique(goal.evidence, summary);
    }

    if (input.linkedTaskId?.trim()) {
      pushUnique(goal.linkedTaskIds, input.linkedTaskId.trim());
    }

    goal.updatedAt = now;
    await this.writeGoals(data);
    return goal;
  }

  public async updateStatus(
    goalId: string,
    status: GoalStatus,
  ): Promise<GoalRecord> {
    const data = await this.readGoals();
    let goal = requireGoal(data, goalId);
    goal.status = status;
    goal.updatedAt = new Date().toISOString();

    if (status === "completed" || status === "cancelled") {
      data.active = data.active.filter((entry) => entry.id !== goalId);
      data.archived.unshift(goal);
    } else if (data.archived.some((entry) => entry.id === goalId)) {
      data.archived = data.archived.filter((entry) => entry.id !== goalId);
      data.active.push(goal);
    }

    await this.writeGoals(data);
    goal = requireGoal(data, goalId);
    return goal;
  }

  public async getPromptContext(): Promise<string | null> {
    const activeGoals = await this.listGoals("active");
    const lines = ["## GOALS.md", "", "### Active Goals"];

    if (activeGoals.length === 0) {
      lines.push("- No active user goals recorded.");
      return lines.join("\n");
    }

    for (const goal of activeGoals) {
      lines.push(`- ${goal.title} [${goal.status}]`);
      lines.push(`  Rationale: ${goal.rationale}`);
      if (goal.deadline) {
        lines.push(`  Deadline: ${goal.deadline}`);
      }
      if (goal.timeHorizon) {
        lines.push(`  Horizon: ${goal.timeHorizon}`);
      }
      if (goal.progress.length > 0) {
        const latest = goal.progress[goal.progress.length - 1];
        lines.push(`  Latest progress: ${latest.summary}`);
      }
    }

    return lines.join("\n");
  }

  private async readGoals(): Promise<GoalsFileData> {
    await this.ensureGoalsFile();
    const content = await fs.readFile(this.goalsPath, "utf8");
    return parseGoalsMarkdown(content);
  }

  private async writeGoals(data: GoalsFileData): Promise<void> {
    await fs.writeFile(this.goalsPath, renderGoalsMarkdown(data), "utf8");
  }
}

function emptyGoalsFile(): GoalsFileData {
  return { active: [], archived: [] };
}

function renderGoalsMarkdown(data: GoalsFileData): string {
  return `# GOALS.md

User goals that the agent should consider during planning.

- Goals are user-owned intentions, not operational jobs.
- The agent may update progress, evidence, and status.
- The agent must not invent goals that the user never stated.

## Active Goals
${renderSection(ACTIVE_START, ACTIVE_END, data.active)}

## Archived Goals
${renderSection(ARCHIVED_START, ARCHIVED_END, data.archived)}
`;
}

function renderSection(
  startMarker: string,
  endMarker: string,
  value: GoalRecord[],
): string {
  return `${startMarker}
\`\`\`json
${JSON.stringify(value, null, 2)}
\`\`\`
${endMarker}`;
}

function parseGoalsMarkdown(content: string): GoalsFileData {
  return {
    active: parseSection(content, ACTIVE_START, ACTIVE_END),
    archived: parseSection(content, ARCHIVED_START, ARCHIVED_END),
  };
}

function parseSection(
  content: string,
  startMarker: string,
  endMarker: string,
): GoalRecord[] {
  const match = new RegExp(
    `${escapeRegExp(startMarker)}\\s*\\\`\\\`\\\`json\\s*([\\s\\S]*?)\\s*\\\`\\\`\\\`\\s*${escapeRegExp(endMarker)}`,
    "m",
  ).exec(content);

  if (!match) {
    return [];
  }

  try {
    const parsed = JSON.parse(match[1]) as GoalRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function requireGoal(data: GoalsFileData, goalId: string): GoalRecord {
  const goal =
    data.active.find((entry) => entry.id === goalId) ||
    data.archived.find((entry) => entry.id === goalId);
  if (!goal) {
    throw new Error(`Goal not found: ${goalId}`);
  }
  return goal;
}

function pushUnique(values: string[], next: string): void {
  if (!values.includes(next)) {
    values.push(next);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
