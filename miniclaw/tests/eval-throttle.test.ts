import { describe, expect, it } from "vitest";
import { EvalThrottle } from "../src/eval/throttle";

describe("EvalThrottle", () => {
  it("serializes provider calls and respects cooldowns", async () => {
    const throttle = new EvalThrottle({
      llmMaxConcurrency: 1,
      gwsMaxConcurrency: 1,
      llmCooldownMs: 0,
      gwsCooldownMs: 25,
      turnCooldownMs: 0,
      maxToolCallsPerScenario: 10,
    });
    const events: string[] = [];
    const times: number[] = [];

    await Promise.all([
      throttle.run("gws", async () => {
        events.push("start-1");
        times.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push("end-1");
      }),
      throttle.run("gws", async () => {
        events.push("start-2");
        times.push(Date.now());
        events.push("end-2");
      }),
    ]);

    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(20);
  });
});
