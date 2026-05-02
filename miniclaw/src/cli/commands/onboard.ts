import { Command } from "commander";
import { OnboardService } from "@/services/onboard";
import { ConfigService } from "@/services/config";
import { pkgName } from "@/utils/pkg";

export function onboardCommand() {
  return new Command("onboard")
    .description("Initialize the Miniclaw environment (config and directories)")
    .action(async () => {
      const configService = new ConfigService(pkgName);
      const service = new OnboardService(configService, pkgName);
      await service.execute();
    });
}
