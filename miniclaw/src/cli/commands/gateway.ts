import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.js";
import { MessageBus } from "../../bus/index.js";
import { startGateway } from "../../gateway/runtime.js";

export default defineCommand({
	meta: {
		name: "gateway",
		description: "Start the unified Miniclaw Gateway and Agent",
	},
	args: {
		config: {
			type: "string",
			description: "Path to a custom config file",
			alias: "c",
		},
	},
	async run({ args }) {
		try {
			const config = await loadConfig({ configPath: args.config });
			const bus = new MessageBus();

			const server = await startGateway(config, bus);

			// Graceful shutdown
			process.on("SIGINT", () => {
				console.log("\nShutting down miniclaw...");
				server.close();
				process.exit(0);
			});
		} catch (error) {
			console.error("Failed to start gateway:");
			console.error(error);
			process.exit(1);
		}
	},
});
