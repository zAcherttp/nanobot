import { exec } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CalendarSafetyPolicy,
  ProviderThrottle,
} from "./calendar/runtime";
import { CalendarSafetyError } from "./calendar/runtime";
import { logger } from "@/utils/logger";

const execAsync = promisify(exec);
const MAX_TIMEOUT_SECONDS = 600;
const MAX_OUTPUT_CHARS = 10_000;
const PREVIEW_CHARS = 120;

export interface ExecToolConfig {
  enable: boolean;
  timeout: number;
  pathAppend: string;
  sandbox: string;
  allowedEnvKeys: string[];
}

export interface ShellExecutionRecord {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  startedAt: string;
  finishedAt?: string;
  simulated: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  blocked?: boolean;
  reason?: string;
  classification: ShellCommandClassification;
}

export interface ShellExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  simulated: boolean;
  blocked?: boolean;
  reason?: string;
  classification: ShellCommandClassification;
}

export interface ShellExecutionOptions {
  command: string;
  workingDir?: string;
  timeoutSeconds?: number;
  allowMutatingGws?: boolean;
}

export interface ShellSimulationAdapter {
  execute(
    command: string,
    classification: ShellCommandClassification,
  ): Promise<ShellExecutionResult>;
}

export interface ShellCommandClassification {
  provider: "gws" | "generic";
  action: "read" | "write" | "other";
  label: string;
}

export interface ShellExecutionServiceOptions {
  workspacePath: string;
  toolConfig: ExecToolConfig;
  restrictToWorkspace: boolean;
  safetyPolicy?: CalendarSafetyPolicy;
  throttle?: ProviderThrottle;
  simulationAdapter?: ShellSimulationAdapter;
  onExecution?: (record: ShellExecutionRecord) => void;
  enableLogging?: boolean;
}

export interface EvalCleanupSummary {
  deleted: string[];
  scanned: string[];
}

export class ShellExecutionService {
  private readonly workspacePath: string;
  private readonly toolConfig: ExecToolConfig;
  private readonly restrictToWorkspace: boolean;
  private readonly safetyPolicy?: CalendarSafetyPolicy;
  private readonly throttle?: ProviderThrottle;
  private readonly simulationAdapter?: ShellSimulationAdapter;
  private readonly onExecution?: (record: ShellExecutionRecord) => void;
  private readonly enableLogging: boolean;

  constructor(options: ShellExecutionServiceOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.toolConfig = options.toolConfig;
    this.restrictToWorkspace = options.restrictToWorkspace;
    this.safetyPolicy = options.safetyPolicy;
    this.throttle = options.throttle;
    this.simulationAdapter = options.simulationAdapter;
    this.onExecution = options.onExecution;
    this.enableLogging = options.enableLogging ?? true;
  }

  public async execute(
    options: ShellExecutionOptions,
  ): Promise<ShellExecutionResult> {
    const classification = classifyShellCommand(options.command);
    const timeoutSeconds = clampTimeout(
      options.timeoutSeconds || this.toolConfig.timeout,
    );
    const cwd = path.resolve(options.workingDir || this.workspacePath);
    const startedAt = new Date().toISOString();

    let blockedReason: string | null = this.guardCommand(options.command, cwd);
    if (!blockedReason) {
      try {
        blockedReason = this.guardMutatingGwsCommand(
          options.command,
          classification,
          options.allowMutatingGws === true,
        );
      } catch (error) {
        blockedReason = error instanceof Error ? error.message : String(error);
      }
    }

    if (blockedReason) {
      const record: ShellExecutionRecord = {
        command: options.command,
        cwd,
        timeoutSeconds,
        startedAt,
        finishedAt: new Date().toISOString(),
        simulated: Boolean(this.simulationAdapter),
        blocked: true,
        reason: blockedReason,
        classification,
      };
      this.logRecord(record);
      this.onExecution?.(record);
      return {
        stdout: `Error: ${blockedReason}`,
        stderr: "",
        exitCode: 1,
        simulated: Boolean(this.simulationAdapter),
        blocked: true,
        reason: blockedReason,
        classification,
      };
    }

    const task = async (): Promise<ShellExecutionResult> => {
      if (this.simulationAdapter) {
        return this.simulationAdapter.execute(options.command, classification);
      }

      const env = this.buildEnv();
      const shellCommand = this.applyPathAppend(options.command, env);
      const execution = await execAsync(shellCommand, {
        cwd,
        timeout: timeoutSeconds * 1000,
        env,
        windowsHide: true,
        maxBuffer: 2_000_000,
      })
        .then((result) => ({
          stdout: result.stdout || "",
          stderr: result.stderr || "",
          exitCode: 0,
        }))
        .catch((error: any) => ({
          stdout: error?.stdout || "",
          stderr: error?.stderr || error?.message || "",
          exitCode:
            typeof error?.code === "number"
              ? error.code
              : error?.killed
                ? 124
                : 1,
        }));

      return {
        stdout: truncateShellOutput(String(execution.stdout || "")),
        stderr: truncateShellOutput(String(execution.stderr || "")),
        exitCode: execution.exitCode,
        simulated: false,
        classification,
      };
    };

    const result = this.throttle
      ? await this.throttle.run(
          classification.provider === "gws" ? "gws" : "llm",
          task,
        )
      : await task();

    const record: ShellExecutionRecord = {
      command: options.command,
      cwd,
      timeoutSeconds,
      startedAt,
      finishedAt: new Date().toISOString(),
      simulated: result.simulated,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      blocked: result.blocked,
      reason: result.reason,
      classification,
    };
    this.logRecord(record);
    this.onExecution?.(record);
    return result;
  }

  public async cleanupEvalTaggedGwsEvents(): Promise<EvalCleanupSummary> {
    if (!this.safetyPolicy?.enabled) {
      throw new CalendarSafetyError(
        "Calendar cleanup requires an enabled safety policy.",
      );
    }

    const start = this.safetyPolicy.safeWindow.start;
    const end = this.safetyPolicy.safeWindow.end;
    const listCommand = `gws calendar events list --calendar primary --timeMin "${start}" --timeMax "${end}" --format json`;
    const listResult = await this.execute({
      command: listCommand,
      allowMutatingGws: false,
    });

    const events = parseEvalCleanupEvents(listResult.stdout);
    const deleted: string[] = [];
    const scanned: string[] = [];

    for (const event of events) {
      scanned.push(event.id);
      if (!event.summary.startsWith(this.safetyPolicy.eventPrefix)) {
        continue;
      }

      await this.execute({
        command: `gws calendar events delete --calendar primary --eventId "${event.id}" --summary "${event.summary}" --start "${event.start}" --end "${event.end}"`,
        allowMutatingGws: true,
      });
      deleted.push(event.id);
    }

    return { deleted, scanned };
  }

  private logRecord(record: ShellExecutionRecord): void {
    if (!this.enableLogging) {
      return;
    }

    logger.info(
      {
        command: truncatePreview(record.command),
        cwd: truncatePreview(record.cwd),
        timeoutSeconds: record.timeoutSeconds,
        exitCode: record.exitCode,
        simulated: record.simulated,
        blocked: record.blocked,
        reason: record.reason ? truncatePreview(record.reason) : undefined,
        stdout: record.stdout ? truncatePreview(record.stdout) : undefined,
        stderr: record.stderr ? truncatePreview(record.stderr) : undefined,
        classification: record.classification,
      },
      "Shell execution",
    );
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv =
      process.platform === "win32"
        ? {
            SYSTEMROOT: process.env.SYSTEMROOT || "C:\\Windows",
            COMSPEC: process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe",
            USERPROFILE: process.env.USERPROFILE || "",
            HOMEDRIVE: process.env.HOMEDRIVE || "C:",
            HOMEPATH: process.env.HOMEPATH || "\\",
            TEMP: process.env.TEMP || os.tmpdir(),
            TMP: process.env.TMP || os.tmpdir(),
            PATHEXT: process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD",
            PATH: process.env.PATH || "",
            APPDATA: process.env.APPDATA || "",
            LOCALAPPDATA: process.env.LOCALAPPDATA || "",
            ProgramData: process.env.ProgramData || "",
            ProgramFiles: process.env.ProgramFiles || "",
            "ProgramFiles(x86)": process.env["ProgramFiles(x86)"] || "",
            ProgramW6432: process.env.ProgramW6432 || "",
          }
        : {
            HOME: process.env.HOME || os.homedir(),
            LANG: process.env.LANG || "C.UTF-8",
            TERM: process.env.TERM || "dumb",
          };

    for (const key of this.toolConfig.allowedEnvKeys) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key];
      }
    }
    return env;
  }

  private applyPathAppend(command: string, env: NodeJS.ProcessEnv): string {
    if (!this.toolConfig.pathAppend) {
      return command;
    }

    if (process.platform === "win32") {
      env.PATH = `${env.PATH || ""}${path.delimiter}${this.toolConfig.pathAppend}`;
      return command;
    }

    return `export PATH="$PATH:${this.toolConfig.pathAppend}"; ${command}`;
  }

  private guardCommand(command: string, cwd: string): string | null {
    const lower = command.trim().toLowerCase();
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(lower)) {
        return "command blocked by safety guard (dangerous pattern detected)";
      }
    }

    if (containsPrivateUrl(command)) {
      return "command blocked by safety guard (internal/private URL detected)";
    }

    if (!this.restrictToWorkspace) {
      return null;
    }

    const workspacePath = this.workspacePath;
    if (!isWithinWorkspace(cwd, workspacePath)) {
      return "working_dir is outside the configured workspace";
    }

    if (command.includes("../") || command.includes("..\\")) {
      return "command blocked by safety guard (path traversal detected)";
    }

    for (const candidate of extractAbsolutePaths(command)) {
      if (!isWithinWorkspace(candidate, workspacePath)) {
        return "command blocked by safety guard (path outside working dir)";
      }
    }

    return null;
  }

  private guardMutatingGwsCommand(
    command: string,
    classification: ShellCommandClassification,
    allowMutatingGws: boolean,
  ): string | null {
    if (
      classification.provider !== "gws" ||
      classification.action !== "write"
    ) {
      return null;
    }

    if (!allowMutatingGws) {
      return "mutating gws commands require an active ask_user approval state";
    }

    if (this.safetyPolicy?.enabled) {
      enforceSafeWindow(command, this.safetyPolicy);
      enforceEvalPrefix(command, this.safetyPolicy);
    }

    return null;
  }
}

export class SimulatedGwsShellAdapter implements ShellSimulationAdapter {
  private readonly events = new Map<
    string,
    { id: string; title: string; start: string; end: string }
  >();
  private sequence = 0;

  constructor(
    seedEvents: Array<{
      id: string;
      title: string;
      start: string;
      end: string;
    }> = [],
  ) {
    for (const event of seedEvents) {
      this.events.set(event.id, { ...event });
    }
    this.sequence = seedEvents.length;
  }

  public async execute(
    command: string,
    classification: ShellCommandClassification,
  ): Promise<ShellExecutionResult> {
    if (classification.provider !== "gws") {
      return {
        stdout:
          "simulate mode only supports gws shell commands in the eval harness.",
        stderr: "",
        exitCode: 0,
        simulated: true,
        classification,
      };
    }

    const lower = command.toLowerCase();
    if (classification.action === "read") {
      if (lower.includes("events list") && lower.includes("--format json")) {
        return {
          stdout: JSON.stringify({
            items: [...this.events.values()].map((event) => ({
              id: event.id,
              summary: event.title,
              start: { dateTime: event.start },
              end: { dateTime: event.end },
            })),
          }),
          stderr: "",
          exitCode: 0,
          simulated: true,
          classification,
        };
      }

      const lines = [...this.events.values()]
        .sort((left, right) => left.start.localeCompare(right.start))
        .map(
          (event) =>
            `${event.start} -> ${event.end} | ${event.title} | ${event.id}`,
        );
      return {
        stdout:
          lines.length > 0 ? lines.join("\n") : "No events found in range.",
        stderr: "",
        exitCode: 0,
        simulated: true,
        classification,
      };
    }

    if (lower.includes("+insert") || lower.includes(" events insert")) {
      const title =
        extractFlagValue(command, ["--summary", "--title"]) || "Untitled";
      const start = extractFlagValue(command, ["--start"]) || "";
      const end = extractFlagValue(command, ["--end"]) || "";
      this.sequence += 1;
      const id = `sim_evt_${this.sequence}`;
      this.events.set(id, { id, title, start, end });
      return {
        stdout: `Created event\nEvent ID: ${id}\n`,
        stderr: "",
        exitCode: 0,
        simulated: true,
        classification,
      };
    }

    if (lower.includes(" events delete")) {
      const id = extractFlagValue(command, ["--eventId", "--eventid"]) || "";
      if (id) {
        this.events.delete(id);
      }
      return {
        stdout: id ? `Deleted event ${id}\n` : "Deleted event\n",
        stderr: "",
        exitCode: 0,
        simulated: true,
        classification,
      };
    }

    return {
      stdout: "OK",
      stderr: "",
      exitCode: 0,
      simulated: true,
      classification,
    };
  }
}

const DANGEROUS_PATTERNS = [
  /\brm\s+-[rf]{1,2}\b/,
  /\bdel\s+\/[fq]\b/,
  /\brmdir\s+\/s\b/,
  /(?:^|[;&|]\s*)format\b/,
  /\b(mkfs|diskpart)\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/sd/,
  /\b(shutdown|reboot|poweroff)\b/,
  /:\(\)\s*\{.*\};\s*:/,
  />>?\s*\S*(?:history\.jsonl|\.dream_cursor)/,
  /\btee\b[^|;&<>]*(?:history\.jsonl|\.dream_cursor)/,
  /\b(?:cp|mv)\b(?:\s+[^\s|;&<>]+)+\s+\S*(?:history\.jsonl|\.dream_cursor)/,
  /\bdd\b[^|;&<>]*\bof=\S*(?:history\.jsonl|\.dream_cursor)/,
  /\bsed\s+-i[^|;&<>]*(?:history\.jsonl|\.dream_cursor)/,
];

export function classifyShellCommand(
  command: string,
): ShellCommandClassification {
  const lower = command.trim().toLowerCase();

  if (!lower.startsWith("gws ")) {
    return {
      provider: "generic",
      action: "other",
      label: "generic",
    };
  }

  if (
    /\bgws\s+(schema|calendar\s+--help)\b/.test(lower) ||
    /\bgws\s+calendar\s+\+agenda\b/.test(lower) ||
    /\bgws\s+calendar\s+events\s+list\b/.test(lower)
  ) {
    return {
      provider: "gws",
      action: "read",
      label: "gws-calendar-read",
    };
  }

  if (
    /\bgws\s+calendar\s+(\+insert|\+update|\+delete)\b/.test(lower) ||
    /\bgws\s+calendar\s+events\s+(insert|update|delete|patch|move)\b/.test(
      lower,
    )
  ) {
    return {
      provider: "gws",
      action: "write",
      label: "gws-calendar-write",
    };
  }

  return {
    provider: "gws",
    action: "other",
    label: "gws-other",
  };
}

function clampTimeout(timeout: number): number {
  return Math.min(Math.max(1, timeout), MAX_TIMEOUT_SECONDS);
}

function truncateShellOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) {
    return value;
  }

  const half = Math.floor(MAX_OUTPUT_CHARS / 2);
  return `${value.slice(0, half)}\n\n... (${value.length - MAX_OUTPUT_CHARS} chars truncated) ...\n\n${value.slice(-half)}`;
}

function truncatePreview(value: string): string {
  return value.length > PREVIEW_CHARS
    ? `${value.slice(0, PREVIEW_CHARS)}...`
    : value;
}

function containsPrivateUrl(command: string): boolean {
  const matches = command.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  for (const match of matches) {
    try {
      const url = new URL(match);
      const host = url.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host.endsWith(".local") ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
      ) {
        return true;
      }
    } catch {
      // Ignore malformed URLs during guard evaluation.
    }
  }
  return false;
}

function isWithinWorkspace(candidate: string, workspacePath: string): boolean {
  try {
    const resolved = path.resolve(candidate);
    const workspace = path.resolve(workspacePath);
    return (
      resolved === workspace || resolved.startsWith(`${workspace}${path.sep}`)
    );
  } catch {
    return false;
  }
}

function extractAbsolutePaths(command: string): string[] {
  const windowsPaths = command.match(/[A-Za-z]:\\[^\s"'|><;]*/g) || [];
  const posixPaths =
    command
      .match(/(?:^|[\s|>'"])(\/[^\s"'>;|<]+)/g)
      ?.map((value) => value.trim()) || [];
  const homePaths =
    command
      .match(/(?:^|[\s|>'"])(~[^\s"'>;|<]*)/g)
      ?.map((value) => value.trim()) || [];

  return [...windowsPaths, ...posixPaths, ...homePaths].map((value) =>
    value.replace(/^['"]|['"]$/g, ""),
  );
}

function enforceSafeWindow(
  command: string,
  policy: CalendarSafetyPolicy,
): void {
  const start = extractFlagValue(command, ["--start"]);
  const end = extractFlagValue(command, ["--end"]);
  if (!start || !end) {
    throw new CalendarSafetyError(
      "Blocked write: missing --start/--end flags for safe-window validation.",
    );
  }

  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const safeStart = new Date(policy.safeWindow.start).getTime();
  const safeEnd = new Date(policy.safeWindow.end).getTime();

  if (
    Number.isNaN(startMs) ||
    Number.isNaN(endMs) ||
    startMs < safeStart ||
    endMs > safeEnd
  ) {
    throw new CalendarSafetyError(
      `Blocked write: calendar write is outside the safe eval window ${policy.safeWindow.start} -> ${policy.safeWindow.end}.`,
    );
  }
}

function enforceEvalPrefix(
  command: string,
  policy: CalendarSafetyPolicy,
): void {
  const title = extractFlagValue(command, ["--summary", "--title"]) || "";
  if (!title.startsWith(policy.eventPrefix)) {
    throw new CalendarSafetyError(
      `Blocked write: calendar writes during eval must use the "${policy.eventPrefix}" prefix.`,
    );
  }
}

function extractFlagValue(command: string, flags: string[]): string | null {
  for (const flag of flags) {
    const pattern = new RegExp(
      `${escapeRegExp(flag)}\\s+(?:"([^"]+)"|'([^']+)'|(\\S+))`,
      "i",
    );
    const match = command.match(pattern);
    if (match) {
      return match[1] || match[2] || match[3] || null;
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface EvalCleanupEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
}

function parseEvalCleanupEvents(stdout: string): EvalCleanupEvent[] {
  try {
    const parsed = JSON.parse(stdout);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return items
      .map((item) => ({
        id: String(item?.id || ""),
        summary: String(item?.summary || item?.title || ""),
        start: String(item?.start?.dateTime || item?.start || ""),
        end: String(item?.end?.dateTime || item?.end || ""),
      }))
      .filter((item) => item.id && item.summary && item.start && item.end);
  } catch {
    return [];
  }
}
