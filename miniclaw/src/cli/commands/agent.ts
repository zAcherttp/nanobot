import { Command } from "commander";
import { AgentService } from "../../services/agent";
import { ConfigService } from "../../services/config";
import { FileSystemService } from "../../services/fs";
import { pkgName } from "@/utils/pkg";

export function agentCommand() {
  return new Command("agent")
    .description("Start the Miniclaw interactive Agent CLI")
    .option("-c, --config <path>", "Path to config file")
    .action(async (options) => {
      const fsService = new FileSystemService(pkgName);
      const configService = new ConfigService(fsService);
      const agentService = new AgentService(configService);

      await agentService.execute(options.config);
    });
}
