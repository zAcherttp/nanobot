import { ConfigService } from "./config";
import { MessageBus } from "../bus/index";
import { startGateway } from "../gateway/runtime";
import { logger } from "../utils/logger";
import chalk from "chalk";

export class GatewayService {
  constructor(private readonly configService: ConfigService) {}

  public async execute(configPath?: string): Promise<void> {
    logger.info(chalk.cyan("Loading Miniclaw configuration..."));
    const config = await this.configService.load({ configPath });

    logger.info(chalk.cyan("Initializing Message Bus..."));
    const bus = new MessageBus();

    const server = await startGateway(config, bus);

    // Graceful shutdown
    process.on("SIGINT", () => {
      logger.info(chalk.yellow("\nShutting down miniclaw..."));
      server.close();
      process.exit(0);
    });
  }
}
