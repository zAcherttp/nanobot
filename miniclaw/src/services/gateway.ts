import chalk from "chalk";
import { AgentLoop } from "../agent/loop";
import { MessageBus } from "../bus/index";
import { ChannelRegistry } from "../channels/base";
import { SseChannel } from "../channels/sse";
import { TelegramChannel } from "../channels/telegram";
import { startGateway } from "../gateway/runtime";
import { configureLogger, logger } from "../utils/logger";
import type { ConfigService } from "./config";
import { FileSystemService } from "./fs";
import { PersistenceService } from "./persistence";

export class GatewayService {
  constructor(private readonly configService: ConfigService) {}

  public async execute(configPath?: string): Promise<void> {
    logger.info(chalk.cyan("Loading Miniclaw configuration..."));
    const config = await this.configService.load({ configPath });
    configureLogger(config.logging.level);

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

    if (config.channels.telegram.enabled) {
      if (config.channels.telegram.botToken) {
        registry.register(
          new TelegramChannel(
            bus,
            config.channels.telegram.botToken,
            config.channels.telegram.allowedUsers,
          ),
        );
      } else {
        logger.warn(
          "Telegram channel is enabled but botToken is missing. Telegram channel will not be started.",
        );
      }
    }

    await registry.startAll();

    // Start Agent Core
    const loop = new AgentLoop(bus, persistenceSvc, config);
    loop.start();

    const server = await startGateway(config, bus, sseChannel);

    const shutdownSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    let shuttingDown = false;
    let resolveShutdown!: () => void;

    const waitForShutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });

    const closeServer = () =>
      new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });

    const gracefulShutdown = async (signal: NodeJS.Signals) => {
      if (shuttingDown) {
        logger.warn(
          `Received ${signal} while shutdown is already in progress.`,
        );
        return;
      }

      shuttingDown = true;
      logger.info(chalk.yellow(`Shutting down miniclaw (${signal})...`));

      let exitCode = 0;
      try {
        await registry.stopAll();
        await closeServer();
        logger.info(chalk.green("Miniclaw shutdown complete."));
      } catch (err) {
        exitCode = 1;
        logger.error({ err }, "Failed during miniclaw shutdown");
      } finally {
        for (const shutdownSignal of shutdownSignals) {
          const handler = signalHandlers.get(shutdownSignal);
          if (handler) {
            process.off(shutdownSignal, handler);
          }
        }

        process.exitCode = exitCode;
        resolveShutdown();
      }
    };

    for (const signal of shutdownSignals) {
      const handler = () => {
        void gracefulShutdown(signal);
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    await waitForShutdown;
  }
}
