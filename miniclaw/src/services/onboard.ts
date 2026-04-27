import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { ConfigService } from "./config";
import { getRootDir, getConfigPath } from "../utils/paths";
import { logger } from "../utils/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class OnboardService {
  constructor(
    private readonly configService: ConfigService,
    private readonly appName: string = "miniclaw",
  ) {}

  public async execute(): Promise<void> {
    const miniclawDir = getRootDir(this.appName);
    const configPath = getConfigPath(this.appName);

    const shouldCreate = await this.checkAndConfirmOverwrite(configPath);
    if (!shouldCreate) {
      return;
    }

    await this.setupEnvironment(miniclawDir, configPath);
  }

  private async checkAndConfirmOverwrite(configPath: string): Promise<boolean> {
    try {
      await fs.access(configPath);
      // If no error, file exists
      logger.warn(`Existing configuration found at ${chalk.cyan(configPath)}`);
      const overwrite = await confirm({
        message: "Do you want to overwrite the existing config.json?",
        default: false,
      });

      if (!overwrite) {
        logger.info(chalk.yellow("Onboarding cancelled by user."));
        return false;
      }
      return true;
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        // Unexpected error, bubble up to CLI layer
        throw error;
      }
      // File does not exist, safe to create
      return true;
    }
  }

  private async setupEnvironment(
    miniclawDir: string,
    configPath: string,
  ): Promise<void> {
    logger.info(`Creating directory ${chalk.cyan(miniclawDir)}...`);
    await fs.mkdir(miniclawDir, { recursive: true });

    logger.info("Generating default config.json...");
    const config = await this.configService.init(configPath);

    const workspaceDir = path.resolve(miniclawDir, config.workspace.path);
    const threadsDir = path.resolve(miniclawDir, config.thread.store.path);
    const skillsDir = path.resolve(workspaceDir, "skills");
    const cronDir = path.resolve(miniclawDir, "cron");
    const memoryDir = path.resolve(workspaceDir, "memory");

    logger.info("Creating required sub-directories...");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(threadsDir, { recursive: true });
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.mkdir(cronDir, { recursive: true });
    await fs.mkdir(memoryDir, { recursive: true });

    logger.info("Creating template files...");
    await this.createTemplateFiles(workspaceDir);

    logger.info("Creating skill directories...");
    await this.createSkillDirectories(skillsDir);

    logger.info(chalk.green("Successfully onboarded Miniclaw!"));
    logger.info(`- Config:    ${chalk.cyan(configPath)}`);
    logger.info(`- Workspace: ${chalk.cyan(workspaceDir)}`);
    logger.info(`- Threads:   ${chalk.cyan(threadsDir)}`);
    logger.info(`- Skills:    ${chalk.cyan(skillsDir)}`);
    logger.info(`- Cron:      ${chalk.cyan(cronDir)}`);
    logger.info(`- Memory:    ${chalk.cyan(memoryDir)}`);
    logger.info(`You can now run: ${chalk.bold("miniclaw gateway")}`);
  }

  private async createTemplateFiles(workspaceDir: string): Promise<void> {
    const templateDir = path.resolve(__dirname, "../../templates");
    const templateFiles = [
      "AGENTS.md",
      "GOALS.md",
      "SOUL.md",
      "USER.md",
      "TOOLS.md",
    ];

    for (const filename of templateFiles) {
      const sourcePath = path.join(templateDir, filename);
      const destPath = path.join(workspaceDir, filename);

      try {
        const content = await fs.readFile(sourcePath, "utf8");
        await fs.writeFile(destPath, content, "utf8");
        logger.debug(`Created ${chalk.cyan(filename)}`);
      } catch (err) {
        logger.warn(`Failed to copy ${filename}: ${err}`);
      }
    }
  }

  private async createSkillDirectories(skillsDir: string): Promise<void> {
    const templateSkillsDir = path.resolve(__dirname, "../../skills");
    const skillNames = ["calendar", "planning", "reminders", "summary"];

    for (const skillName of skillNames) {
      const skillDir = path.join(skillsDir, skillName);
      await fs.mkdir(skillDir, { recursive: true });

      const sourcePath = path.join(templateSkillsDir, skillName, "SKILL.md");
      const destPath = path.join(skillDir, "SKILL.md");

      try {
        const content = await fs.readFile(sourcePath, "utf8");
        await fs.writeFile(destPath, content, "utf8");
        logger.debug(`Created skill ${chalk.cyan(skillName)}`);
      } catch (err) {
        logger.warn(`Failed to copy skill ${skillName}: ${err}`);
      }
    }
  }
}
