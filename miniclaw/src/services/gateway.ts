import { ConfigService } from "./config";
import { MessageBus } from "../bus/index";
import { startGateway } from "../gateway/runtime";
import { logger } from "../utils/logger";
import chalk from "chalk";

import { ChannelRegistry } from "../channels/base";
import { SseChannel } from "../channels/sse";
import { TelegramChannel } from "../channels/telegram";
import { PersistenceService } from "./persistence";
import { FileSystemService } from "./fs";
import { AgentLoop } from "../agent/loop";

export class GatewayService {
  constructor(private readonly configService: ConfigService) {}

  public async execute(configPath?: string): Promise<void> {
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

    logger.info(chalk.cyan("Initializing Channel Registry..."));
    const registry = new ChannelRegistry(bus, config);

    let sseChannel: SseChannel | undefined;

    if (config.channels.sse.enabled) {
      sseChannel = new SseChannel(bus);
      registry.register(sseChannel);
    }

    if (config.channels.telegram.enabled && config.channels.telegram.botToken) {
      registry.register(
        new TelegramChannel(
          bus,
          config.channels.telegram.botToken,
          config.channels.telegram.allowedUsers,
        ),
      );
    }

    await registry.startAll();

    // Start Agent Core
    const loop = new AgentLoop(bus, persistenceSvc, config);
    loop.start();

    const server = await startGateway(config, bus, sseChannel);

    // Graceful shutdown
    process.on("SIGINT", async () => {
      logger.info(chalk.yellow("\nShutting down miniclaw..."));
      await registry.stopAll();
      server.close();
      process.exit(0);
    });
  }
}
