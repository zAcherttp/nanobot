import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { EvalScenario } from "./types";

const ScenarioSchema: z.ZodType<EvalScenario> = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  mode: z.enum(["simulate", "sandbox-live"]),
  complexity: z.enum(["simple", "moderate", "complex"]),
  description: z.string().optional(),
  seed: z
    .object({
      userProfile: z.string().optional(),
      goals: z.string().optional(),
      tasks: z.string().optional(),
      memory: z.string().optional(),
      soul: z.string().optional(),
      agents: z.string().optional(),
      tools: z.string().optional(),
      skills: z.record(z.string()).optional(),
      calendarEvents: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            start: z.string(),
            end: z.string(),
            description: z.string().optional(),
            location: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  calendarAssumptions: z.array(z.string()).optional(),
  turns: z.array(z.string().min(1)).min(1),
  assertions: z
    .object({
      recallNeedles: z.array(z.string()).optional(),
      clarificationNeedles: z.array(z.string()).optional(),
      requireClarification: z.boolean().optional(),
      requireProposalBeforeWrite: z.boolean().optional(),
      blockWriteWithoutExplicitConfirmation: z.boolean().optional(),
      requiredMemoryTool: z.string().optional(),
      requireLongHorizonTaskTracking: z.boolean().optional(),
    })
    .default({}),
  rubricWeights: z.object({
    recallRelevance: z.number().min(0),
    planningCoherence: z.number().min(0),
    consentPolicyAdherence: z.number().min(0),
    proposalUsefulness: z.number().min(0),
    efficiency: z.number().min(0),
  }),
  providerBudgets: z
    .object({
      maxToolCalls: z.number().int().positive().optional(),
      maxDurationMs: z.number().int().positive().optional(),
      turnCooldownMs: z.number().int().min(0).optional(),
    })
    .optional(),
});

export async function loadEvalScenario(
  filePath: string,
): Promise<EvalScenario> {
  const content = await fs.readFile(filePath, "utf8");
  const parsed = ScenarioSchema.safeParse(JSON.parse(content));
  if (!parsed.success) {
    throw new Error(
      `Invalid eval scenario ${filePath}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return parsed.data;
}

export async function loadEvalScenarios(
  directoryPath: string,
): Promise<EvalScenario[]> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const scenarios = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => loadEvalScenario(path.join(directoryPath, entry.name))),
  );

  return scenarios.sort((left, right) => left.id.localeCompare(right.id));
}
