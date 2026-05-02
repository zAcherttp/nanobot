import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceMemoryService } from "../src/services/workspace_memory";
import { createWorkspaceMemoryTools } from "../src/tools/memory";

describe("workspace memory tools", () => {
  let tempDir: string;
  let service: WorkspaceMemoryService;
  let tools: ReturnType<typeof createWorkspaceMemoryTools>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "miniclaw-memory-tools-"));
    service = new WorkspaceMemoryService(tempDir);
    await service.ensureMemoryFile();
    tools = createWorkspaceMemoryTools(service);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("records and lists entries through the tool interface", async () => {
    const recordTool = tools.find((tool) => tool.name === "record_memory_entry");
    const listTool = tools.find((tool) => tool.name === "list_memory_entries");
    expect(recordTool).toBeTruthy();
    expect(listTool).toBeTruthy();

    await recordTool!.execute("tool-1", {
      category: "decision",
      summary: "Use gws for agenda reads.",
      tags: ["gws", "calendar"],
    });

    const result = await listTool!.execute("tool-2", {});
    expect(result.content[0].text).toContain("Use gws for agenda reads.");
  });

  it("updates and removes entries through the tool interface", async () => {
    const entry = await service.recordEntry({
      category: "constraint",
      summary: "Never write without explicit confirmation.",
      tags: ["calendar"],
    });
    const updateTool = tools.find((tool) => tool.name === "update_memory_entry");
    const removeTool = tools.find((tool) => tool.name === "remove_memory_entry");

    await updateTool!.execute("tool-3", {
      entry_id: entry.id,
      summary: "Never write to the calendar without explicit confirmation.",
      tags: ["calendar", "confirmation"],
    });

    expect((await service.getEntry(entry.id))?.summary).toContain(
      "without explicit confirmation",
    );

    await removeTool!.execute("tool-4", { entry_id: entry.id });
    expect(await service.getEntry(entry.id)).toBeNull();
  });
});
