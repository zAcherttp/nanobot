import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { MessageBus } from "../bus/index.js";
import { createApiRouter } from "./routes.js";
import { createSSERouter } from "./sse.js";

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
