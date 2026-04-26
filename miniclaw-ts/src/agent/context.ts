import { promises as fs } from "node:fs";
import path from "node:path";

export interface BuildSystemPromptOptions {
  workspacePath: string;
  channel?: string;
}

const USER_HEURISTICS_HEADER = "## Confirmed behavioral heuristics";

export async function buildSystemPrompt(
  options: BuildSystemPromptOptions,
): Promise<string> {
  const parts: string[] = [];

  // 1. Format Hint
  const formatHint = buildFormatHint(options.channel);
  if (formatHint) parts.push(formatHint);

  // 2. AGENTS.md
  const agents = await readIfExists(options.workspacePath, "AGENTS.md");
  if (agents) parts.push(`## AGENTS.md\n\n${agents}`);

  // 3. SOUL.md
  const soul = await readIfExists(options.workspacePath, "SOUL.md");
  if (soul) parts.push(`## SOUL.md\n\n${soul}`);

  // 4. USER.md (extracted heuristics)
  const user = await readIfExists(options.workspacePath, "USER.md");
  if (user) {
    const heuristics = extractConfirmedUserHeuristics(user);
    if (heuristics) parts.push(heuristics);
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

export function extractConfirmedUserHeuristics(content: string): string {
  const lines = content.split(/\r?\n/);
  const bullets: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      inSection = trimmed === USER_HEURISTICS_HEADER;
      continue;
    }

    if (!inSection) continue;

    if (trimmed.startsWith("- ")) {
      bullets.push(line);
    }
  }

  if (bullets.length === 0) return "";

  return `${USER_HEURISTICS_HEADER}\n\n${bullets.join("\n")}`;
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
