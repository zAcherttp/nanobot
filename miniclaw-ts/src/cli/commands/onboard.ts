import { Command } from "commander";
import { OnboardService } from "@/services/onboard";
import { ConfigService } from "@/services/config";
import { FileSystemService } from "@/services/fs";
import { pkgName } from "@/utils/pkg";

export function onboardCommand() {
  return new Command("onboard")
    .description("Initialize the Miniclaw environment (config and directories)")
    .action(async () => {
      const fsService = new FileSystemService(pkgName);
      const configService = new ConfigService(fsService);
      const service = new OnboardService(configService, fsService);
      await service.execute();
    });
}
