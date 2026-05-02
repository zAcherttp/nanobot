import { promises as fs } from "node:fs";
import path from "node:path";
import type { GoalService } from "../services/goals";
import type { TaskService } from "../services/tasks";
import type { UserProfileService } from "../services/user_profile";
import type { WorkspaceMemoryService } from "../services/workspace_memory";

export interface BuildSystemPromptOptions {
  workspacePath: string;
  threadPath?: string;
  channel?: string;
  summary?: string;
  skillsSummary?: string;
  goalService?: GoalService;
  taskService?: TaskService;
  userProfileService?: UserProfileService;
  memoryService?: WorkspaceMemoryService;
  relevantMemory?: string | null;
  relevantHistory?: string | null;
}

export async function buildSystemPrompt(
  options: BuildSystemPromptOptions,
): Promise<string> {
  const parts: string[] = [];

  let summary = options.summary;
  if (options.threadPath && !summary) {
    summary = await readSummaryFile(options.threadPath);
  }
  if (summary && summary.trim()) {
    parts.push(`## Conversation Summary\n\n${summary}`);
  }

  const formatHint = buildFormatHint(options.channel);
  if (formatHint) parts.push(formatHint);

  const bootstrap = await loadBootstrapFiles(options.workspacePath);
  if (bootstrap) parts.push(bootstrap);

  const userContext = await options.userProfileService?.getPromptContext();
  if (userContext) parts.push(userContext);

  const goalContext = await options.goalService?.getPromptContext();
  if (goalContext) parts.push(goalContext);

  const taskContext = await options.taskService?.getPromptContext();
  if (taskContext) parts.push(taskContext);

  const memoryContext = await options.memoryService?.getPromptContext();
  if (memoryContext) parts.push(memoryContext);

  if (options.relevantMemory?.trim()) {
    parts.push(options.relevantMemory.trim());
  }

  if (options.relevantHistory?.trim()) {
    parts.push(options.relevantHistory.trim());
  }

  if (options.skillsSummary) {
    parts.push(buildSkillsSection(options.skillsSummary));
  }

  return parts.join("\n\n---\n\n");
}

function buildFormatHint(channel?: string): string {
  switch (channel) {
    case "telegram":
    case "qq":
    case "discord":
      return "## Format Hint\nThis conversation is on a messaging app. Use short paragraphs. Avoid tables and oversized headings.";
    case "whatsapp":
    case "sms":
      return "## Format Hint\nThis conversation is on a plain text messaging platform. Use plain text only.";
    case "email":
      return "## Format Hint\nThis conversation is via email. Use simple sections and keep formatting conservative.";
    case "cli":
    case "mochat":
      return "## Format Hint\nOutput is rendered in a terminal. Avoid markdown headings and tables.";
    default:
      return "";
  }
}

async function loadBootstrapFiles(workspacePath: string): Promise<string> {
  const BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "TOOLS.md"];
  const parts: string[] = [];

  for (const filename of BOOTSTRAP_FILES) {
    const content = await readIfExists(workspacePath, filename);
    if (content) {
      parts.push(`## ${filename}\n\n${content}`);
    }
  }

  return parts.join("\n\n");
}

function buildSkillsSection(skillsSummary: string): string {
  return `## Available Skills

You have access to various skills that can help you accomplish tasks. Skills are not loaded by default to keep context efficient.

${skillsSummary}

Important:
- Use \`list_skills\` to inspect the catalog.
- Use \`load_skill\` only when you need full instructions for the current turn.
- Loaded skill content is turn-scoped and should be reloaded later if needed.`;
}

async function readIfExists(
  workspacePath: string,
  filename: string,
): Promise<string | null> {
  try {
    const filePath = path.join(workspacePath, filename);
    const content = await fs.readFile(filePath, "utf8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function readSummaryFile(threadPath: string): Promise<string | null> {
  try {
    const summaryPath = path.join(threadPath, "summary.md");
    const content = await fs.readFile(summaryPath, "utf8");
    return content.trim() || null;
  } catch {
    return null;
  }
}
