import { Hono } from "hono";
import { MessageBus } from "../bus/index.js";
import { BusMessage } from "../bus/types.js";
import { randomUUID } from "node:crypto";

export function createApiRouter(bus: MessageBus): Hono {
	const app = new Hono();

	app.get("/health", (c) => {
		return c.json({ status: "ok", timestamp: Date.now() });
	});

	app.post("/messages", async (c) => {
		try {
			const body = await c.req.json();

			if (!body.content || typeof body.content !== "string") {
				return c.json({ error: "Invalid content" }, 400);
			}

			const message: BusMessage = {
				id: randomUUID(),
				role: "user",
				content: body.content,
				timestamp: Date.now(),
			};

			bus.publishInbound(message);

			return c.json({ status: "received", messageId: message.id });
		} catch (e) {
			return c.json({ error: "Invalid payload" }, 400);
		}
	});

	return app;
}
