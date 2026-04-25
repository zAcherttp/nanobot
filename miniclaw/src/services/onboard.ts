import path from "node:path";
import { promises as fs } from "node:fs";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { ConfigService } from "./config";
import { logger } from "../utils/logger";

export class OnboardService {
  constructor(
    private readonly configService: ConfigService,
    private readonly cwd: string = process.cwd(),
  ) {}

  public async execute(): Promise<void> {
    const miniclawDir = path.resolve(this.cwd, ".miniclaw");
    const configPath = path.resolve(miniclawDir, "config.json");

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

    logger.info("Creating required sub-directories...");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(threadsDir, { recursive: true });

    logger.info(chalk.green("Successfully onboarded Miniclaw!"));
    logger.info(`- Config:    ${chalk.cyan(configPath)}`);
    logger.info(`- Workspace: ${chalk.cyan(workspaceDir)}`);
    logger.info(`- Threads:   ${chalk.cyan(threadsDir)}`);
    logger.info(`You can now run: ${chalk.bold("miniclaw gateway")}`);
  }
}
