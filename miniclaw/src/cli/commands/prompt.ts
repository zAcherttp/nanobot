import { Command } from "commander";
import { ConfigService } from "@/services/config";
import { SystemPromptDumpService } from "@/services/system_prompt_dump";
import { pkgName } from "@/utils/pkg";

export function promptCommand() {
  const command = new Command("prompt").description(
    "Generate prompt artifacts from a Miniclaw workspace",
  );

  command
    .command("dump")
    .description(
      "Generate a SYSTEM_PROMPT_<epoch>.md file from the configured workspace",
    )
    .argument(
      "[miniclawDir]",
      "Path to the Miniclaw root directory that contains config.json",
    )
    .option("-c, --config <path>", "Path to config file")
    .option("--channel <channel>", "Channel format hint to use", "cli")
    .action(async (miniclawDir, options) => {
      const service = new SystemPromptDumpService(
        new ConfigService(pkgName),
        pkgName,
      );
      const result = await service.execute({
        miniclawDir,
        configPath: options.config,
        channel: options.channel,
      });

      console.log(JSON.stringify(result, null, 2));
    });

  return command;
}
