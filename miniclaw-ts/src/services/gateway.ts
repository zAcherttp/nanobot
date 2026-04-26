import type { ConfigService } from "./config";
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

		let shuttingDown = false;

		const gracefulShutdown = async (signal: NodeJS.Signals) => {
			if (shuttingDown) return;
			shuttingDown = true;

			logger.info(chalk.yellow(`Shutting down miniclaw (${signal})...`));

			let exitCode = 0;

			try {
				// 1. Stop channels (your registry.stopAll is already async)
				await registry.stopAll();

				// 2. Close the HTTP server properly
				await new Promise<void>((resolve, reject) => {
					server.close((err) => {
						if (err) reject(err);
						else resolve();
					});
				});

				// Optional: stop the agent loop if it has a stop method
				// if (typeof loop.stop === 'function') await loop.stop();

				logger.info(chalk.green("Miniclaw shutdown complete."));
			} catch (err) {
				exitCode = 1;
				logger.error({ err }, "Failed during miniclaw shutdown");
			} finally {
				// Remove listeners to prevent double-handling
				process.removeAllListeners("SIGINT");
				process.removeAllListeners("SIGTERM");

				// Do NOT call process.exit() immediately in dev.
				// Let the event loop drain naturally.
				// pnpm (and most dev runners) handle natural exit better.

				// Small delay helps logs flush and pnpm see clean exit
				setTimeout(() => {
					process.exitCode = exitCode; // preferred over process.exit()
					// process.exit(exitCode);     // only use if you really need to force it
				}, 100);
			}
		};

		process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
		process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));

		// Keep the main promise alive so the process doesn't exit early
		// (your original waitForShutdown pattern)
		await new Promise<void>((resolve) => {
			// We resolve only after shutdown is fully done
			const onShutdownDone = () => resolve();
			// You can attach this if needed, but with the setTimeout above it's usually fine
		});
	}
}
