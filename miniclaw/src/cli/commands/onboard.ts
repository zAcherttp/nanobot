import { Command } from "commander";
import { OnboardService } from "@/services/onboard";
import { ConfigService } from "@/services/config";

export function onboardCommand() {
  return new Command("onboard")
    .description("Initialize the Miniclaw environment (config and directories)")
    .action(async () => {
      const configService = new ConfigService();
      const service = new OnboardService(configService);
      await service.execute();
    });
}
