import { Command } from "commander";
import { ConfigService } from "@/services/config";
import { EvalService } from "@/services/eval";
import { pkgName } from "@/utils/pkg";

export function evalCommand() {
  const command = new Command("eval").description(
    "Run Miniclaw evaluation scenarios and reports",
  );

  command
    .command("run")
    .description("Run all eval scenarios or a single scenario by id")
    .argument("[scenarioId]", "Scenario id to run")
    .option("-c, --config <path>", "Path to config file")
    .option("-m, --mode <mode>", "Eval mode: simulate or sandbox-live")
    .option("-o, --output-dir <dir>", "Override report output directory")
    .option(
      "--keep-workspace",
      "Keep the per-scenario eval workspace on disk for inspection",
    )
    .option(
      "--safe-window-start <iso>",
      "Override the safe calendar window start",
    )
    .option("--safe-window-end <iso>", "Override the safe calendar window end")
    .action(async (scenarioId, options) => {
      const service = new EvalService(new ConfigService(pkgName));
      const result = scenarioId
        ? await service.runOne(scenarioId, {
            configPath: options.config,
            mode: options.mode,
            outputDir: options.outputDir,
            keepWorkspace: options.keepWorkspace,
            safeWindowStart: options.safeWindowStart,
            safeWindowEnd: options.safeWindowEnd,
          })
        : await service.runAll({
            configPath: options.config,
            mode: options.mode,
            outputDir: options.outputDir,
            keepWorkspace: options.keepWorkspace,
            safeWindowStart: options.safeWindowStart,
            safeWindowEnd: options.safeWindowEnd,
          });

      console.log(JSON.stringify(result, null, 2));
    });

  command
    .command("summary")
    .description("Print the latest eval report summary")
    .option("-c, --config <path>", "Path to config file")
    .option("-o, --output-dir <dir>", "Override report output directory")
    .action(async (options) => {
      const service = new EvalService(new ConfigService(pkgName));
      const summary = await service.printLatestSummary({
        configPath: options.config,
        outputDir: options.outputDir,
      });
      console.log(summary || "No eval summary found.");
    });

  command
    .command("cleanup")
    .description("Delete eval-tagged calendar events inside the safe window")
    .option("-c, --config <path>", "Path to config file")
    .option(
      "--safe-window-start <iso>",
      "Override the safe calendar window start",
    )
    .option("--safe-window-end <iso>", "Override the safe calendar window end")
    .action(async (options) => {
      const service = new EvalService(new ConfigService(pkgName));
      const deleted = await service.cleanupCalendarEvents({
        configPath: options.config,
        safeWindowStart: options.safeWindowStart,
        safeWindowEnd: options.safeWindowEnd,
      });
      console.log(JSON.stringify({ deleted }, null, 2));
    });

  return command;
}
