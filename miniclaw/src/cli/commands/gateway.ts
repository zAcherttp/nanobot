import { Command } from "commander";
import { ConfigService } from "@/services/config";
import { GatewayService } from "@/services/gateway";
import { pkgName } from "@/utils/pkg";

export function gatewayCommand() {
  return new Command("gateway")
    .description("Start the unified Miniclaw Gateway and Agent")
    .option("-c, --config <path>", "Path to a custom config file")
    .action(async (options) => {
      const configService = new ConfigService(pkgName);
      const service = new GatewayService(configService);
      await service.execute(options.config);
    });
}
