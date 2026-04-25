import { Command } from "commander";
import { loadConfig } from "../../config/loader.js";
import { MessageBus } from "../../bus/index.js";
import { startGateway } from "../../gateway/runtime.js";

export function gatewayCommand() {
  return new Command("gateway")
    .description("Start the unified Miniclaw Gateway and Agent")
    .option("-c, --config <path>", "Path to a custom config file")
    .action(async (options) => {
      try {
        const config = await loadConfig({ configPath: options.config });
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
    });
}
