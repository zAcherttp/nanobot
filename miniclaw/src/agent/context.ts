import { promises as fs } from "node:fs";
import path from "node:path";
import { MemoryStore } from "../services/memory";

export interface BuildSystemPromptOptions {
  workspacePath: string;
  threadPath?: string;
  channel?: string;
  summary?: string;
  skillsPath?: string;
  skillsSummary?: string;
  memoryStore?: MemoryStore;
}

export async function buildSystemPrompt(
  options: BuildSystemPromptOptions,
): Promise<string> {
  const parts: string[] = [];

  // 1. Conversation Summary (from file if provided, or from options)
  let summary = options.summary;
  if (options.threadPath && !summary) {
    summary = await readSummaryFile(options.threadPath);
  }
  if (summary && summary.trim()) {
    parts.push(`## Conversation Summary\n\n${summary}`);
  }

  // 2. Long-term Memory (if available)
  if (options.memoryStore) {
    const memoryContext = await options.memoryStore.getMemoryContext();
    if (memoryContext) {
      parts.push(memoryContext);
    }
  }

  // 3. Format Hint
  const formatHint = buildFormatHint(options.channel);
  if (formatHint) parts.push(formatHint);

  // 4. Bootstrap files (AGENTS.md, GOALS.md, SOUL.md, USER.md, TOOLS.md)
  const bootstrap = await loadBootstrapFiles(options.workspacePath);
  if (bootstrap) parts.push(bootstrap);

  // 5. Skills hint and summary
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
  const BOOTSTRAP_FILES = [
    "AGENTS.md",
    "GOALS.md",
    "SOUL.md",
    "USER.md",
    "TOOLS.md",
  ];
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

**Important**: When you need specific capabilities, use the \`load_skill\` tool to load the skill's instructions. Use \`list_skills\` to see all available skills.`;
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
