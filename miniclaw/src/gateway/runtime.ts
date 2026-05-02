import { serve } from "@hono/node-server";
import { AppConfig } from "../config/schema";
import { MessageBus } from "../bus/index";
import { createServer } from "../server/index";
import { logger } from "../utils/logger";
import chalk from "chalk";

export async function startGateway(config: AppConfig, bus: MessageBus) {
  const app = createServer(bus);
  const port = config.gateway.port;

  logger.info(`Starting miniclaw unified gateway on port ${port}...`);

  const server = serve({
    fetch: app.fetch,
    port,
  });

  server.on("listening", () => {
    logger.info(
      `Server is running at ${chalk.blue(`http://localhost:${port}`)}`,
    );
    logger.info(
      `- Health check: ${chalk.cyan(`http://localhost:${port}/api/health`)}`,
    );
  });

  // Future Agent instantiation will be wired to the bus here

  return server;
}
