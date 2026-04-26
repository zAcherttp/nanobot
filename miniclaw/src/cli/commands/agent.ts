import { Command } from "commander";
import { pkgName } from "@/utils/pkg";
import { CliAgentService } from "../../services/cli_agent";
import { ConfigService } from "../../services/config";
import { FileSystemService } from "../../services/fs";

export function agentCommand() {
  return new Command("agent")
    .description("Start the Miniclaw interactive Agent CLI")
    .option("-c, --config <path>", "Path to config file")
    .action(async (options) => {
      const fsService = new FileSystemService(pkgName);
      const configService = new ConfigService(fsService);
      const agentService = new CliAgentService(configService);

      await agentService.execute(options.config);
    });
}
