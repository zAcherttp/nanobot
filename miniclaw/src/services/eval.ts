import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigService } from "./config";
import { ShellExecutionService } from "./shell";
import { readLatestEvalSummary } from "@/eval/reporter";
import { EvalRunner } from "@/eval/runner";
import { loadEvalScenarios } from "@/eval/scenario";
import type { EvalMode, EvalRunConfig } from "@/eval/types";
import type { CalendarSafetyPolicy } from "./calendar/runtime";
import type { AppConfig } from "@/config/schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCENARIO_DIR = path.resolve(__dirname, "../../eval/scenarios");

export interface EvalCommandOptions {
  configPath?: string;
  mode?: EvalMode;
  outputDir?: string;
  safeWindowStart?: string;
  safeWindowEnd?: string;
}

export class EvalService {
  constructor(private readonly configService: ConfigService) {}

  public async runAll(options: EvalCommandOptions = {}) {
    const runner = await this.createRunner(options);
    return runner.runAll();
  }

  public async runOne(scenarioId: string, options: EvalCommandOptions = {}) {
    const runner = await this.createRunner(options);
    return runner.runOne(scenarioId);
  }

  public async printLatestSummary(
    options: Pick<EvalCommandOptions, "configPath" | "outputDir"> = {},
  ): Promise<string | null> {
    const config = await this.configService.load({
      configPath: options.configPath,
    });
    const outputDir = options.outputDir || config.eval?.outputDir;
    if (!outputDir) {
      return null;
    }
    return readLatestEvalSummary(outputDir);
  }

  public async cleanupCalendarEvents(
    options: EvalCommandOptions = {},
  ): Promise<string[]> {
    const config = await this.configService.load({
      configPath: options.configPath,
    });
    const shellService = new ShellExecutionService({
      workspacePath: config.workspace.path,
      toolConfig: {
        enable: config.tools.exec.enable,
        timeout: config.tools.exec.timeout,
        pathAppend: config.tools.exec.pathAppend,
        sandbox: config.tools.exec.sandbox,
        allowedEnvKeys: config.tools.exec.allowedEnvKeys,
      },
      restrictToWorkspace: config.tools.restrictToWorkspace,
      safetyPolicy: buildSafetyPolicy(config, options),
    });
    const result = await shellService.cleanupEvalTaggedGwsEvents();
    return result.deleted;
  }

  private async createRunner(options: EvalCommandOptions): Promise<EvalRunner> {
    const runConfig = await this.buildRunConfig(options);
    return new EvalRunner(runConfig);
  }

  private async buildRunConfig(
    options: EvalCommandOptions,
  ): Promise<EvalRunConfig> {
    const config = await this.configService.load({
      configPath: options.configPath,
    });
    const scenarios = await loadEvalScenarios(DEFAULT_SCENARIO_DIR);

    return {
      config,
      scenarios,
      mode: options.mode || config.eval?.defaultMode || "simulate",
      outputDir:
        options.outputDir ||
        config.eval?.outputDir ||
        path.resolve(process.cwd(), "eval-reports"),
      safePolicy: buildSafetyPolicy(config, options),
      throttle: {
        llmMaxConcurrency: config.eval?.throttle.llmMaxConcurrency || 1,
        gwsMaxConcurrency: config.eval?.throttle.gwsMaxConcurrency || 1,
        llmCooldownMs: config.eval?.throttle.llmCooldownMs || 0,
        gwsCooldownMs: config.eval?.throttle.gwsCooldownMs || 250,
        turnCooldownMs: config.eval?.throttle.turnCooldownMs || 100,
        maxToolCallsPerScenario:
          config.eval?.throttle.maxToolCallsPerScenario || 20,
      },
      scenarioTimeoutMs: config.eval?.timeouts.scenarioMs || 120000,
      turnTimeoutMs: config.eval?.timeouts.turnMs || 30000,
    };
  }
}

function buildSafetyPolicy(
  config: AppConfig,
  options: EvalCommandOptions,
): CalendarSafetyPolicy {
  return {
    enabled: true,
    safeWindow: {
      start:
        options.safeWindowStart ||
        config.eval?.safeWindow.start ||
        "2026-06-01T00:00:00.000Z",
      end:
        options.safeWindowEnd ||
        config.eval?.safeWindow.end ||
        "2026-06-30T23:59:59.000Z",
    },
    eventPrefix: config.eval?.eventPrefix || "[MINICLAW-EVAL]",
    requireTaggedEventForMutations: true,
  };
}
