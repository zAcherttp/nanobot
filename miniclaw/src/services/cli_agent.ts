import type { ConfigService } from "./config";
import { MessageBus } from "../bus/index";
import { ChannelRegistry } from "../channels/base";
import { CliChannel } from "../channels/cli";
import { PersistenceService } from "./persistence";
import { AgentLoop } from "../agent/loop";
import { configureLogger, logger } from "../utils/logger";
import chalk from "chalk";

export class CliAgentService {
  constructor(private readonly configService: ConfigService) {}

  public async execute(configPath?: string): Promise<void> {
    logger.info(chalk.cyan("Loading Miniclaw configuration..."));
    const config = await this.configService.load({ configPath });

    if (!config.channels.cli.enabled) {
      logger.error(chalk.red("CLI channel is disabled in config"));
      process.exit(1);
    }

    logger.info(chalk.cyan("Initializing Message Bus..."));
    const bus = new MessageBus();

    logger.info(chalk.cyan("Initializing Persistence..."));
    const persistenceSvc = new PersistenceService(
      this.configService,
      "miniclaw",
    );

    logger.info(chalk.cyan("Initializing Channel Registry - CLI ..."));
    const registry = new ChannelRegistry(bus, config);

    // Exclusively register the CLI channel for the agent command
    registry.register(new CliChannel(bus));

    await registry.startAll();

    // Keep interactive CLI output clean by suppressing framework logs in agent mode.
    configureLogger("silent");

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
