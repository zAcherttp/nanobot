import { describe, expect, it } from "vitest";
import {
  ShellExecutionService,
  SimulatedGwsShellAdapter,
} from "../src/services/shell";
import { CalendarSafetyError } from "../src/services/calendar/runtime";

const safetyPolicy = {
  enabled: true,
  safeWindow: {
    start: "2026-06-01T00:00:00.000Z",
    end: "2026-06-30T23:59:59.000Z",
  },
  eventPrefix: "[MINICLAW-EVAL]",
  requireTaggedEventForMutations: true,
} as const;

const toolConfig = {
  enable: true,
  timeout: 60,
  pathAppend: "",
  sandbox: "",
  allowedEnvKeys: [],
};

describe("ShellExecutionService gws safety", () => {
  it("blocks out-of-window writes and write commands without the eval prefix", async () => {
    const service = new ShellExecutionService({
      workspacePath: process.cwd(),
      toolConfig,
      restrictToWorkspace: false,
      safetyPolicy,
      simulationAdapter: new SimulatedGwsShellAdapter(),
    });

    const outsideWindow = await service.execute({
      command:
        'gws calendar +insert --summary "[MINICLAW-EVAL] Outside range" --start "2026-07-01T09:00:00.000Z" --end "2026-07-01T10:00:00.000Z"',
      allowMutatingGws: true,
    });
    expect(outsideWindow.blocked).toBe(true);
    expect(outsideWindow.reason).toContain("outside the safe eval window");

    const missingPrefix = await service.execute({
      command:
        'gws calendar +insert --summary "Normal event" --start "2026-06-12T09:00:00.000Z" --end "2026-06-12T10:00:00.000Z"',
      allowMutatingGws: true,
    });
    expect(missingPrefix.blocked).toBe(true);
    expect(missingPrefix.reason).toContain("[MINICLAW-EVAL]");
  });

  it("cleans up eval-tagged events through shell execution", async () => {
    const service = new ShellExecutionService({
      workspacePath: process.cwd(),
      toolConfig,
      restrictToWorkspace: false,
      safetyPolicy,
      simulationAdapter: new SimulatedGwsShellAdapter([
        {
          id: "evt-1",
          title: "[MINICLAW-EVAL] Deep work",
          start: "2026-06-12T09:00:00.000Z",
          end: "2026-06-12T10:00:00.000Z",
        },
        {
          id: "evt-2",
          title: "Normal event",
          start: "2026-06-12T11:00:00.000Z",
          end: "2026-06-12T12:00:00.000Z",
        },
      ]),
    });

    const result = await service.cleanupEvalTaggedGwsEvents();

    expect(result.deleted).toEqual(["evt-1"]);
    expect(result.scanned).toEqual(["evt-1", "evt-2"]);
  });

  it("requires an enabled safety policy for eval cleanup", async () => {
    const service = new ShellExecutionService({
      workspacePath: process.cwd(),
      toolConfig,
      restrictToWorkspace: false,
      simulationAdapter: new SimulatedGwsShellAdapter(),
    });

    await expect(service.cleanupEvalTaggedGwsEvents()).rejects.toBeInstanceOf(
      CalendarSafetyError,
    );
  });
});
