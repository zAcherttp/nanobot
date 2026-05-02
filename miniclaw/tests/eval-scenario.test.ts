import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEvalScenario, loadEvalScenarios } from "../src/eval/scenario";

describe("eval scenario loader", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "miniclaw-eval-scenario-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("loads a valid scenario file", async () => {
    const filePath = path.join(tempDir, "valid.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        id: "recall_preference_simple",
        title: "Recall preference",
        mode: "simulate",
        complexity: "simple",
        turns: ["hello"],
        assertions: {
          recallNeedles: ["morning"],
        },
        rubricWeights: {
          recallRelevance: 1,
          planningCoherence: 1,
          consentPolicyAdherence: 1,
          proposalUsefulness: 1,
          efficiency: 1,
        },
      }),
      "utf8",
    );

    const scenario = await loadEvalScenario(filePath);
    expect(scenario.id).toBe("recall_preference_simple");
    expect(scenario.turns).toEqual(["hello"]);
  });

  it("rejects malformed scenarios and loads a directory pack", async () => {
    const invalidPath = path.join(tempDir, "invalid.json");
    const validPath = path.join(tempDir, "valid.json");

    await fs.writeFile(
      invalidPath,
      JSON.stringify({
        id: "",
        mode: "simulate",
      }),
      "utf8",
    );
    await fs.writeFile(
      validPath,
      JSON.stringify({
        id: "workspace_convention_reuse",
        title: "Workspace convention",
        mode: "simulate",
        complexity: "moderate",
        turns: ["hello"],
        assertions: {},
        rubricWeights: {
          recallRelevance: 1,
          planningCoherence: 1,
          consentPolicyAdherence: 1,
          proposalUsefulness: 1,
          efficiency: 1,
        },
      }),
      "utf8",
    );

    await expect(loadEvalScenario(invalidPath)).rejects.toThrow(
      "Invalid eval scenario",
    );
    await fs.rm(invalidPath, { force: true });

    const pack = await loadEvalScenarios(tempDir);
    expect(pack).toHaveLength(1);
    expect(pack[0].id).toBe("workspace_convention_reuse");
  });
});
