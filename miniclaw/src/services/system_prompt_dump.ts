import { promises as fs } from "node:fs";
import path from "node:path";
import { buildSystemPrompt } from "@/agent/context";
import { SkillsLoader } from "@/agent/skills";
import { getRootDir } from "@/utils/paths";
import { GoalService } from "./goals";
import type { ConfigService } from "./config";
import { TaskService } from "./tasks";
import { UserProfileService } from "./user_profile";
import {
  copyWorkspaceSkillDirectories,
  copyWorkspaceTemplateFiles,
} from "./workspace_bootstrap";
import { WorkspaceMemoryService } from "./workspace_memory";

export interface DumpSystemPromptOptions {
  miniclawDir?: string;
  configPath?: string;
  channel?: string;
}

export interface DumpSystemPromptResult {
  miniclawDir: string;
  configPath: string;
  workspacePath: string;
  outputPath: string;
}

export class SystemPromptDumpService {
  constructor(
    private readonly configService: ConfigService,
    private readonly appName: string = "miniclaw",
  ) {}

  public async execute(
    options: DumpSystemPromptOptions = {},
  ): Promise<DumpSystemPromptResult> {
    const resolvedConfigPath = this.resolveConfigPath(options);
    const miniclawDir = path.dirname(resolvedConfigPath);
    const config = await this.configService.load({
      configPath: resolvedConfigPath,
    });

    await copyWorkspaceTemplateFiles(config.workspace.path);
    await copyWorkspaceSkillDirectories(config.workspace.path);

    const userProfileService = new UserProfileService(config.workspace.path);
    const goalService = new GoalService(config.workspace.path);
    const taskService = new TaskService(config.workspace.path);
    const memoryService = new WorkspaceMemoryService(config.workspace.path);
    await Promise.all([
      userProfileService.ensureProfileFile(),
      goalService.ensureGoalsFile(),
      taskService.ensureTasksFile(),
      memoryService.ensureMemoryFile(),
    ]);

    const skillsLoader = new SkillsLoader(
      path.join(config.workspace.path, "skills"),
    );
    const skillsSummary = await skillsLoader.getSkillSummary();
    const systemPrompt = await buildSystemPrompt({
      workspacePath: config.workspace.path,
      channel: options.channel || "cli",
      skillsSummary,
      userProfileService,
      goalService,
      taskService,
      memoryService,
    });

    const outputPath = path.join(miniclawDir, `SYSTEM_PROMPT_${Date.now()}.md`);
    await fs.writeFile(outputPath, systemPrompt, "utf8");

    return {
      miniclawDir,
      configPath: resolvedConfigPath,
      workspacePath: config.workspace.path,
      outputPath,
    };
  }

  private resolveConfigPath(options: DumpSystemPromptOptions): string {
    if (options.configPath) {
      return path.resolve(options.configPath);
    }

    const miniclawDir = path.resolve(
      options.miniclawDir || getRootDir(this.appName),
    );
    return path.join(miniclawDir, "config.json");
  }
}
