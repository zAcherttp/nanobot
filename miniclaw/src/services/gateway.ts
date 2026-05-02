import { AgentLoop } from "../agent/loop";
import { MessageBus } from "../bus/index";
import { ChannelRegistry } from "../channels/base";
import { TelegramChannel } from "../channels/telegram";
import { startGateway } from "../gateway/runtime";
import { configureLogger, logger } from "../utils/logger";
import { pkgVersion } from "../utils/pkg";
import type { ConfigService } from "./config";
import { PersistenceService } from "./persistence";

const NANOBOT_LOGO = "🐈";

function printGatewayLine(message: string): void {
  console.log(message);
}

function printGatewayStatus(label: string, value: string): void {
  printGatewayLine(`✓ ${label}: ${value}`);
}

function printGatewayWarning(message: string): void {
  printGatewayLine(`Warning: ${message}`);
}

export class GatewayService {
  constructor(private readonly configService: ConfigService) {}

  public async execute(configPath?: string): Promise<void> {
    const config = await this.configService.load({ configPath });
    configureLogger(config.logging.level);
    printGatewayLine(
      `${NANOBOT_LOGO} Starting nanobot gateway version ${pkgVersion} on port ${config.gateway.port}...`,
    );

    const bus = new MessageBus();

    const persistenceSvc = new PersistenceService(
      this.configService,
      "miniclaw",
      {
        threadsDir: config.thread.store.path,
      },
    );

    const registry = new ChannelRegistry(bus, config);
    const enabledChannels: string[] = [];

    if (config.channels.telegram.enabled) {
      if (config.channels.telegram.botToken) {
        enabledChannels.push("telegram");
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
    await loop.start();

    const server = await startGateway(config, bus);

    if (enabledChannels.length > 0) {
      printGatewayStatus("Channels enabled", enabledChannels.join(", "));
    } else {
      printGatewayWarning("No channels enabled");
    }
    printGatewayStatus(
      "Heartbeat",
      config.gateway.heartbeat.enabled
        ? `every ${config.gateway.heartbeat.intervalSeconds}s`
        : "disabled",
    );
    printGatewayStatus(
      "Dream",
      config.dream?.enabled === false
        ? "disabled"
        : config.dream?.schedule || "0 2 * * *",
    );

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
      printGatewayLine("");
      printGatewayLine("Shutting down...");

      let exitCode = 0;
      try {
        await loop.stop();
        await registry.stopAll();
        await closeServer();
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
