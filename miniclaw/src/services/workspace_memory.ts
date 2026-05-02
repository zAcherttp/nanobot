import { promises as fs } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

const DECISIONS_START = "<!-- miniclaw:memory-decisions:start -->";
const DECISIONS_END = "<!-- miniclaw:memory-decisions:end -->";
const CONVENTIONS_START = "<!-- miniclaw:memory-conventions:start -->";
const CONVENTIONS_END = "<!-- miniclaw:memory-conventions:end -->";
const CONSTRAINTS_START = "<!-- miniclaw:memory-constraints:start -->";
const CONSTRAINTS_END = "<!-- miniclaw:memory-constraints:end -->";
const ATTEMPTS_START = "<!-- miniclaw:memory-attempts:start -->";
const ATTEMPTS_END = "<!-- miniclaw:memory-attempts:end -->";

export type MemoryCategory =
  | "decision"
  | "convention"
  | "constraint"
  | "attempt_outcome";

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  summary: string;
  tags: string[];
  source?: string;
  createdAt: string;
  updatedAt: string;
}

interface MemoryDocument {
  decision: MemoryEntry[];
  convention: MemoryEntry[];
  constraint: MemoryEntry[];
  attempt_outcome: MemoryEntry[];
}

export interface RecordMemoryEntryInput {
  category: MemoryCategory;
  summary: string;
  tags?: string[];
  source?: string;
}

export interface UpdateMemoryEntryInput {
  summary?: string;
  tags?: string[];
  source?: string | null;
}

export class WorkspaceMemoryService {
  constructor(private readonly workspacePath: string) {}

  public get memoryPath(): string {
    return path.join(this.workspacePath, "MEMORY.md");
  }

  public async ensureMemoryFile(): Promise<void> {
    try {
      await fs.access(this.memoryPath);
    } catch {
      await fs.mkdir(this.workspacePath, { recursive: true });
      await fs.writeFile(this.memoryPath, renderMemoryMarkdown(emptyDocument()), "utf8");
    }
  }

  public async listEntries(category?: MemoryCategory): Promise<MemoryEntry[]> {
    const document = await this.readDocument();
    if (category) {
      return [...document[category]];
    }

    return [
      ...document.decision,
      ...document.convention,
      ...document.constraint,
      ...document.attempt_outcome,
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public async getEntry(entryId: string): Promise<MemoryEntry | null> {
    const entries = await this.listEntries();
    return entries.find((entry) => entry.id === entryId) || null;
  }

  public async recordEntry(
    input: RecordMemoryEntryInput,
  ): Promise<MemoryEntry> {
    const document = await this.readDocument();
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: `mem_${ulid().toLowerCase()}`,
      category: input.category,
      summary: input.summary.trim(),
      tags: uniqueTags(input.tags || []),
      source: normalizeOptional(input.source),
      createdAt: now,
      updatedAt: now,
    };

    if (entry.summary) {
      document[input.category].push(entry);
      await this.writeDocument(document);
    }

    return entry;
  }

  public async updateEntry(
    entryId: string,
    updates: UpdateMemoryEntryInput,
  ): Promise<MemoryEntry> {
    const document = await this.readDocument();
    const entry = findEntry(document, entryId);
    if (!entry) {
      throw new Error(`Memory entry not found: ${entryId}`);
    }

    if (typeof updates.summary === "string" && updates.summary.trim()) {
      entry.summary = updates.summary.trim();
    }
    if (updates.tags) {
      entry.tags = uniqueTags(updates.tags);
    }
    if (updates.source !== undefined) {
      entry.source = normalizeOptional(updates.source || undefined);
    }
    entry.updatedAt = new Date().toISOString();

    await this.writeDocument(document);
    return entry;
  }

  public async removeEntry(entryId: string): Promise<void> {
    const document = await this.readDocument();
    let removed = false;

    for (const category of memoryCategories()) {
      const originalLength = document[category].length;
      document[category] = document[category].filter((entry) => entry.id !== entryId);
      if (document[category].length !== originalLength) {
        removed = true;
      }
    }

    if (!removed) {
      throw new Error(`Memory entry not found: ${entryId}`);
    }

    await this.writeDocument(document);
  }

  public async searchEntries(
    query: string,
    limit: number = 5,
  ): Promise<MemoryEntry[]> {
    const normalizedQuery = normalizeQuery(query);
    if (normalizedQuery.length === 0) {
      return [];
    }

    const entries = await this.listEntries();
    return entries
      .map((entry) => ({
        entry,
        score: scoreEntry(entry, normalizedQuery),
      }))
      .filter((result) => result.score > 0)
      .sort((left, right) =>
        right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt),
      )
      .slice(0, limit)
      .map((result) => result.entry);
  }

  public async getPromptContext(): Promise<string | null> {
    const document = await this.readDocument();
    const lines = ["## MEMORY.md"];
    let hasContent = false;

    for (const category of memoryCategories()) {
      const entries = document[category];
      if (entries.length === 0) {
        continue;
      }

      hasContent = true;
      lines.push("");
      lines.push(`### ${categoryHeading(category)}`);
      lines.push(
        ...entries.map((entry) => {
          const tags = entry.tags.length > 0 ? ` [tags: ${entry.tags.join(", ")}]` : "";
          return `- ${entry.summary}${tags}`;
        }),
      );
    }

    return hasContent ? lines.join("\n") : null;
  }

  public formatRelevantEntries(entries: MemoryEntry[]): string | null {
    if (entries.length === 0) {
      return null;
    }

    const lines = ["## Relevant Memory", ""];
    for (const entry of entries) {
      const tags = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
      lines.push(`- (${entry.category}) ${entry.summary}${tags}`);
    }
    return lines.join("\n");
  }

  private async readDocument(): Promise<MemoryDocument> {
    await this.ensureMemoryFile();
    const content = await fs.readFile(this.memoryPath, "utf8");
    return parseMemoryMarkdown(content);
  }

  private async writeDocument(document: MemoryDocument): Promise<void> {
    await fs.writeFile(this.memoryPath, renderMemoryMarkdown(document), "utf8");
  }
}

function emptyDocument(): MemoryDocument {
  return {
    decision: [],
    convention: [],
    constraint: [],
    attempt_outcome: [],
  };
}

function memoryCategories(): MemoryCategory[] {
  return ["decision", "convention", "constraint", "attempt_outcome"];
}

function categoryHeading(category: MemoryCategory): string {
  switch (category) {
    case "decision":
      return "Decisions";
    case "convention":
      return "Conventions";
    case "constraint":
      return "Constraints";
    case "attempt_outcome":
      return "Attempts and Outcomes";
  }
}

function sectionMarkers(
  category: MemoryCategory,
): { start: string; end: string } {
  switch (category) {
    case "decision":
      return { start: DECISIONS_START, end: DECISIONS_END };
    case "convention":
      return { start: CONVENTIONS_START, end: CONVENTIONS_END };
    case "constraint":
      return { start: CONSTRAINTS_START, end: CONSTRAINTS_END };
    case "attempt_outcome":
      return { start: ATTEMPTS_START, end: ATTEMPTS_END };
  }
}

function renderMemoryMarkdown(document: MemoryDocument): string {
  const normalized = { ...document };
  for (const category of memoryCategories()) {
    normalized[category] = normalized[category].map((entry) => ({
      ...entry,
      summary: entry.summary.trim(),
      tags: uniqueTags(entry.tags),
      source: normalizeOptional(entry.source),
    }));
  }

  return `# MEMORY.md

Durable workspace and project knowledge that should persist across requests.

- Keep user identity and preferences in USER.md.
- Keep explicit user goals in GOALS.md.
- Keep operational work in TASKS.md.

## Decisions
${renderSection("decision", normalized.decision)}

## Conventions
${renderSection("convention", normalized.convention)}

## Constraints
${renderSection("constraint", normalized.constraint)}

## Attempts and Outcomes
${renderSection("attempt_outcome", normalized.attempt_outcome)}
`;
}

function renderSection(
  category: MemoryCategory,
  entries: MemoryEntry[],
): string {
  const { start, end } = sectionMarkers(category);
  return `${start}
\`\`\`json
${JSON.stringify(entries, null, 2)}
\`\`\`
${end}`;
}

function parseMemoryMarkdown(content: string): MemoryDocument {
  const document = emptyDocument();
  for (const category of memoryCategories()) {
    const { start, end } = sectionMarkers(category);
    document[category] = parseSection(content, start, end).map((entry) => ({
      ...entry,
      category,
      tags: uniqueTags(entry.tags || []),
      source: normalizeOptional(entry.source),
    }));
  }
  return document;
}

function parseSection(
  content: string,
  startMarker: string,
  endMarker: string,
): MemoryEntry[] {
  const match = new RegExp(
    `${escapeRegExp(startMarker)}\\s*\\\`\\\`\\\`json\\s*([\\s\\S]*?)\\s*\\\`\\\`\\\`\\s*${escapeRegExp(endMarker)}`,
    "m",
  ).exec(content);

  if (!match) {
    return [];
  }

  try {
    const parsed = JSON.parse(match[1]) as MemoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function findEntry(
  document: MemoryDocument,
  entryId: string,
): MemoryEntry | null {
  for (const category of memoryCategories()) {
    const match = document[category].find((entry) => entry.id === entryId);
    if (match) {
      return match;
    }
  }
  return null;
}

function normalizeOptional(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function uniqueTags(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function normalizeQuery(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 3),
  )];
}

function scoreEntry(entry: MemoryEntry, queryTokens: string[]): number {
  const haystack = [
    entry.summary.toLowerCase(),
    ...entry.tags.map((tag) => tag.toLowerCase()),
    entry.source?.toLowerCase() || "",
  ].join(" ");

  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
