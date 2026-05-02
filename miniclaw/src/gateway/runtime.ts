import { serve } from "@hono/node-server";
import { AppConfig } from "../config/schema";
import { MessageBus } from "../bus/index";
import { createServer } from "../server/index";

export async function startGateway(config: AppConfig, bus: MessageBus) {
  const app = createServer(bus);
  const port = config.gateway.port;

  const server = serve({
    fetch: app.fetch,
    port,
  });

  server.on("listening", () => {
    console.log(`✓ Health endpoint: http://127.0.0.1:${port}/api/health`);
  });

  // Future Agent instantiation will be wired to the bus here

  return server;
}
