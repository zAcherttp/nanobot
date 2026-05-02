import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceMemoryService } from "../src/services/workspace_memory";

describe("WorkspaceMemoryService", () => {
  let tempDir: string;
  let service: WorkspaceMemoryService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "miniclaw-memory-"));
    service = new WorkspaceMemoryService(tempDir);
    await service.ensureMemoryFile();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates, reads, updates, and removes memory entries by category", async () => {
    const entry = await service.recordEntry({
      category: "decision",
      summary: "Use gws for calendar execution.",
      tags: ["calendar", "gws"],
    });

    expect(await service.listEntries("decision")).toEqual([
      expect.objectContaining({
        id: entry.id,
        category: "decision",
        summary: "Use gws for calendar execution.",
      }),
    ]);

    const updated = await service.updateEntry(entry.id, {
      summary: "Use gws for calendar execution and proposal flow.",
      tags: ["calendar", "proposal"],
    });

    expect(updated.summary).toContain("proposal flow");
    expect(updated.tags).toEqual(["calendar", "proposal"]);

    await service.removeEntry(entry.id);
    expect(await service.getEntry(entry.id)).toBeNull();
  });

  it("recovers cleanly from malformed sections", async () => {
    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      `# MEMORY.md

## Decisions
<!-- miniclaw:memory-decisions:start -->
\`\`\`json
{broken}
\`\`\`
<!-- miniclaw:memory-decisions:end -->

## Constraints
<!-- miniclaw:memory-constraints:start -->
\`\`\`json
[{"id":"mem_1","category":"constraint","summary":"Only use gws.","tags":[],"createdAt":"2026-05-02T00:00:00.000Z","updatedAt":"2026-05-02T00:00:00.000Z"}]
\`\`\`
<!-- miniclaw:memory-constraints:end -->
`,
      "utf8",
    );

    const constraints = await service.listEntries("constraint");
    const decisions = await service.listEntries("decision");

    expect(decisions).toEqual([]);
    expect(constraints).toEqual([
      expect.objectContaining({
        category: "constraint",
        summary: "Only use gws.",
      }),
    ]);
  });

  it("builds curated and relevant prompt sections", async () => {
    await service.recordEntry({
      category: "convention",
      summary: "Ask for explicit confirmation before calendar writes.",
      tags: ["calendar", "confirmation"],
    });
    await service.recordEntry({
      category: "attempt_outcome",
      summary: "Weekly planning proposal worked well.",
      tags: ["planning"],
    });

    const prompt = await service.getPromptContext();
    const relevant = service.formatRelevantEntries(
      await service.searchEntries("calendar confirmation"),
    );

    expect(prompt).toContain("## MEMORY.md");
    expect(prompt).toContain("### Conventions");
    expect(relevant).toContain("## Relevant Memory");
    expect(relevant).toContain(
      "Ask for explicit confirmation before calendar writes.",
    );
  });
});
