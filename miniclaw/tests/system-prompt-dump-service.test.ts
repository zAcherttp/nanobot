import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigService } from "@/services/config";
import { SystemPromptDumpService } from "@/services/system_prompt_dump";

const tempDirs: string[] = [];

describe("SystemPromptDumpService", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("writes a system prompt dump into the configured workspace", async () => {
    const miniclawDir = await makeMiniclawRoot();
    await fs.writeFile(
      path.join(miniclawDir, "config.json"),
      JSON.stringify({}),
      "utf8",
    );

    const service = new SystemPromptDumpService(new ConfigService("miniclaw"));
    const result = await service.execute({
      miniclawDir,
    });

    expect(result.miniclawDir).toBe(miniclawDir);
    expect(result.workspacePath).toBe(path.join(miniclawDir, "workspace"));
    expect(path.dirname(result.outputPath)).toBe(miniclawDir);
    expect(path.basename(result.outputPath)).toMatch(/^SYSTEM_PROMPT_\d+\.md$/);

    const prompt = await fs.readFile(result.outputPath, "utf8");
    expect(prompt).toContain("## Runtime");
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain("## AGENTS.md");
    expect(prompt).toContain("## TOOLS.md");
    expect(prompt).toContain("## USER.md");
    expect(prompt).toContain("## GOALS.md");
    expect(prompt).toContain("## TASKS.md");
    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("**planning**:");
    expect(prompt).toContain("**reminders**:");
    expect(prompt).toContain("**summary**:");
    await expect(
      fs.access(path.join(result.workspacePath, "MEMORY.md")),
    ).resolves.toBeUndefined();
  });

  it("does not overwrite existing workspace guidance files", async () => {
    const miniclawDir = await makeMiniclawRoot();
    const workspaceDir = path.join(miniclawDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(
      path.join(miniclawDir, "config.json"),
      JSON.stringify({}),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      "Custom agent guidance",
      "utf8",
    );

    const service = new SystemPromptDumpService(new ConfigService("miniclaw"));
    const result = await service.execute({
      miniclawDir,
    });

    expect(
      await fs.readFile(path.join(workspaceDir, "AGENTS.md"), "utf8"),
    ).toBe("Custom agent guidance");

    const prompt = await fs.readFile(result.outputPath, "utf8");
    expect(prompt).toContain("Custom agent guidance");
  });
});

async function makeMiniclawRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "miniclaw-prompt-"));
  tempDirs.push(dir);
  return dir;
}
