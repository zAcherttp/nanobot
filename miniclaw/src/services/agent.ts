import { ConfigService } from "./config";
import { MessageBus } from "../bus/index";
import { ChannelRegistry } from "../channels/base";
import { CliChannel } from "../channels/cli";
import { ThreadStorageService } from "./thread";
import { FileSystemService } from "./fs";
import { logger } from "../utils/logger";
import chalk from "chalk";

export class AgentService {
  constructor(private readonly configService: ConfigService) {}

  public async execute(configPath?: string): Promise<void> {
    logger.info(chalk.cyan("Loading Miniclaw configuration..."));
    const config = await this.configService.load({ configPath });

    logger.info(chalk.cyan("Initializing Message Bus..."));
    const bus = new MessageBus();

    logger.info(chalk.cyan("Initializing Thread Storage..."));
    const fsService = new FileSystemService();
    const threadSvc = new ThreadStorageService(fsService, this.configService);

    logger.info(chalk.cyan("Initializing Channel Registry - CLI ..."));
    const registry = new ChannelRegistry(bus, config);

    // Exclusively register the CLI channel for the agent command
    registry.register(new CliChannel(bus));

    await registry.startAll();

    // --- AGENT CORE STUB ---
    // We wire up a temporary loop so the CLI doesn't exit and messages are saved.
    bus.subscribeInbound(async (msg) => {
      try {
        const thread = await threadSvc.getConversationThread();

        // Persist user message
        await threadSvc.appendMessage(thread.id, {
          role: "user",
          content: msg.content,
        });

        // Fake Agent delay to simulate thinking
        await new Promise((resolve) => setTimeout(resolve, 500));

        const response = "I am a stub agent. You said: " + msg.content;

        // Persist agent message
        await threadSvc.appendMessage(thread.id, {
          role: "assistant",
          content: response,
        });

        // Send back to channel
        bus.publishOutbound({
          id: "stub-" + Date.now(),
          role: "assistant",
          content: response,
          timestamp: new Date().toISOString(),
          channel: msg.channel,
          userId: msg.userId,
        });
      } catch (err) {
        logger.error({ err }, "Stub Agent encountered an error");
      }
    });

    // Graceful shutdown
    process.on("SIGINT", async () => {
      logger.info(chalk.yellow("\nShutting down miniclaw agent..."));
      await registry.stopAll();
      process.exit(0);
    });
  }
}
