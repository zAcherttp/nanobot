import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { ShellExecutionService } from "@/services/shell";

interface ExecToolOptions {
  shellService: ShellExecutionService;
  workspacePath: string;
  timeoutSeconds: number;
  canRunMutatingGws: () => Promise<boolean> | boolean;
}

export function createExecTools(
  options: ExecToolOptions,
): AgentTool<any, any>[] {
  return [
    {
      name: "exec",
      label: "Exec",
      description:
        "Execute a shell command and return its output. Prefer grep and glob for file search. Output is truncated at 10,000 chars; timeout defaults to 60s and is capped at 600s.",
      parameters: Type.Object({
        command: Type.String({ minLength: 1 }),
        working_dir: Type.Optional(Type.String()),
        timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600 })),
      }),
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        const allowMutatingGws = await options.canRunMutatingGws();
        const result = await options.shellService.execute({
          command: params.command,
          workingDir: params.working_dir || options.workspacePath,
          timeoutSeconds: params.timeout || options.timeoutSeconds,
          allowMutatingGws,
        });

        const parts: string[] = [];
        if (result.stdout) {
          parts.push(result.stdout);
        }
        if (result.stderr) {
          parts.push(`STDERR:\n${result.stderr}`);
        }
        if (!result.stdout && !result.stderr) {
          parts.push("(no output)");
        }
        parts.push(`Exit code: ${result.exitCode ?? "unknown"}`);

        return {
          content: [{ type: "text", text: parts.join("\n\n") }],
          details: result,
        };
      },
    },
  ];
}
