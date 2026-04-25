import { serve } from "@hono/node-server";
import { AppConfig } from "../config/schema.js";
import { MessageBus } from "../bus/index.js";
import { createServer } from "../server/index.js";

export async function startGateway(config: AppConfig, bus: MessageBus) {
  const app = createServer(bus);
  const port = config.gateway.port;

  console.log(`Starting miniclaw unified gateway on port ${port}...`);

  const server = serve({
    fetch: app.fetch,
    port,
  });

  server.on("listening", () => {
    console.log(`Server is running at http://localhost:${port}`);
    console.log(`- Health check: http://localhost:${port}/api/health`);
    console.log(`- SSE Stream:   http://localhost:${port}/stream`);
  });

  // Future Agent instantiation will be wired to the bus here

  return server;
}
