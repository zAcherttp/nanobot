import type { AppConfig } from "@/config/schema";
import type { CalendarSafetyPolicy } from "@/services/calendar/runtime";
import type { ToolExecutionEvent } from "@/agent/loop";
import type { ShellExecutionRecord } from "@/services/shell";

export type EvalMode = "simulate" | "sandbox-live";
export type EvalComplexity = "simple" | "moderate" | "complex";
export type EvalFailureKind =
  | "assertion_failed"
  | "agent_failed"
  | "infra_failed"
  | "safety_blocked"
  | "timeout";

export interface ThrottleProfile {
  llmMaxConcurrency: number;
  gwsMaxConcurrency: number;
  llmCooldownMs: number;
  gwsCooldownMs: number;
  turnCooldownMs: number;
  maxToolCallsPerScenario: number;
}

export interface EvalScenarioSeed {
  userProfile?: string;
  goals?: string;
  tasks?: string;
  memory?: string;
  soul?: string;
  agents?: string;
  tools?: string;
  skills?: Record<string, string>;
  calendarEvents?: Array<SerializedCalendarEvent>;
}

export interface SerializedCalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
}

export interface EvalScenarioAssertions {
  recallNeedles?: string[];
  clarificationNeedles?: string[];
  requireClarification?: boolean;
  requireProposalBeforeWrite?: boolean;
  blockWriteWithoutExplicitConfirmation?: boolean;
  requiredMemoryTool?: string;
  requireLongHorizonTaskTracking?: boolean;
}

export interface EvalRubricWeights {
  recallRelevance: number;
  planningCoherence: number;
  consentPolicyAdherence: number;
  proposalUsefulness: number;
  efficiency: number;
}

export interface EvalScenarioBudgets {
  maxToolCalls?: number;
  maxDurationMs?: number;
  turnCooldownMs?: number;
}

export interface EvalScenario {
  id: string;
  title: string;
  mode: EvalMode;
  complexity: EvalComplexity;
  description?: string;
  seed?: EvalScenarioSeed;
  calendarAssumptions?: string[];
  turns: string[];
  assertions: EvalScenarioAssertions;
  rubricWeights: EvalRubricWeights;
  providerBudgets?: EvalScenarioBudgets;
}

export interface EvalRunConfig {
  config: AppConfig;
  scenarios: EvalScenario[];
  mode: EvalMode;
  outputDir: string;
  keepWorkspace: boolean;
  safePolicy: CalendarSafetyPolicy;
  throttle: ThrottleProfile;
  scenarioTimeoutMs: number;
  turnTimeoutMs: number;
}

export interface EvalAssertionResult {
  name: string;
  passed: boolean;
  details?: string;
}

export interface EvalRubricScore {
  dimension: keyof EvalRubricWeights;
  score: number;
  weight: number;
  details: string;
}

export interface EvalTurnRecord {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface EvalSnapshots {
  user: string;
  goals: string;
  tasks: string;
  memory: string;
}

export interface EvalToolStat {
  toolName: string;
  total: number;
  successful: number;
  failed: number;
}

export interface EvalToolMetrics {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  byTool: EvalToolStat[];
  skillReads: EvalToolStat[];
}

export interface EvalResult {
  scenarioId: string;
  title: string;
  mode: EvalMode;
  complexity: EvalComplexity;
  passed: boolean;
  failureKind?: EvalFailureKind;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  assertions: EvalAssertionResult[];
  rubric: EvalRubricScore[];
  transcript: EvalTurnRecord[];
  toolCalls: ToolExecutionEvent[];
  toolMetrics: EvalToolMetrics;
  shellExecutions: ShellExecutionRecord[];
  snapshots: EvalSnapshots;
  outputDir: string;
  workspacePath?: string;
}

export interface EvalSummary {
  startedAt: string;
  finishedAt: string;
  outputDir: string;
  total: number;
  passed: number;
  failed: number;
  failuresByKind: Partial<Record<EvalFailureKind, number>>;
  byComplexity: Record<EvalComplexity, { total: number; passed: number }>;
  toolMetrics: EvalToolMetrics;
  results: Array<
    Pick<
      EvalResult,
      | "scenarioId"
      | "title"
      | "passed"
      | "failureKind"
      | "complexity"
      | "durationMs"
      | "toolMetrics"
      | "workspacePath"
    >
  >;
}
