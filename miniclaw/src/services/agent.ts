import chalk from "chalk";
import { AgentLoop } from "../agent/loop";
import { MessageBus } from "../bus/index";
import { ChannelRegistry } from "../channels/base";
import { CliChannel } from "../channels/cli";
import { configureLogger, logger } from "../utils/logger";
import type { ConfigService } from "./config";
import { FileSystemService } from "./fs";
import { PersistenceService } from "./persistence";

export class CliAgentService {
  constructor(private readonly configService: ConfigService) {}

  public async execute(configPath?: string): Promise<void> {
    // Keep interactive CLI output clean by suppressing framework logs in agent mode.
    configureLogger("silent");

    logger.info(chalk.cyan("Loading Miniclaw configuration..."));
    const config = await this.configService.load({ configPath });

    logger.info(chalk.cyan("Initializing Message Bus..."));
    const bus = new MessageBus();

    logger.info(chalk.cyan("Initializing Persistence..."));
    const fsService = new FileSystemService();
    const persistenceSvc = new PersistenceService(
      fsService,
      this.configService,
    );

    logger.info(chalk.cyan("Initializing Channel Registry - CLI ..."));
    const registry = new ChannelRegistry(bus, config);

    // Exclusively register the CLI channel for the agent command
    registry.register(new CliChannel(bus));

    await registry.startAll();

    // Start Agent Core
    const loop = new AgentLoop(bus, persistenceSvc, config);
    loop.start();

    // Graceful shutdown
    process.on("SIGINT", async () => {
      logger.info(chalk.yellow("\nShutting down miniclaw agent..."));
      await registry.stopAll();
      process.exit(0);
    });
  }
}
