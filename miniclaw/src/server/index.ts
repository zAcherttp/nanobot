import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { MessageBus } from "../bus/index";
import { createApiRouter } from "./routes";
import { createSSERouter } from "./sse";

export function createServer(bus: MessageBus): Hono {
  const app = new Hono();

  // Open CORS as requested for local WebUI development
  app.use(
    "*",
    cors({
      origin: "*",
    }),
  );
  app.use("*", logger());

  const apiRouter = createApiRouter(bus);
  const sseRouter = createSSERouter(bus);

  app.route("/api", apiRouter);
  app.route("/stream", sseRouter);

  return app;
}
