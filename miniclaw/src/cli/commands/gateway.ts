import { Command } from "commander";
import { GatewayService } from "@/services/gateway";
import { ConfigService } from "@/services/config";
import { FileSystemService } from "@/services/fs";
import { pkgName } from "@/utils/pkg";

export function gatewayCommand() {
  return new Command("gateway")
    .description("Start the unified Miniclaw Gateway and Agent")
    .option("-c, --config <path>", "Path to a custom config file")
    .action(async (options) => {
      const fsService = new FileSystemService(pkgName);
      const configService = new ConfigService(fsService);
      const service = new GatewayService(configService);
      await service.execute(options.config);
    });
}
