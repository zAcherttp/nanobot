import { Command } from "commander";
import { pkgName } from "@/utils/pkg";
import { CliAgentService } from "../../services/cli_agent";
import { ConfigService } from "../../services/config";

export function agentCommand() {
  return new Command("agent")
    .description("Start the Miniclaw interactive Agent CLI")
    .option("-c, --config <path>", "Path to config file")
    .action(async (options) => {
      const configService = new ConfigService(pkgName);
      const agentService = new CliAgentService(configService);

      await agentService.execute(options.config);
    });
}
