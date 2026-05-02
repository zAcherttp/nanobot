import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  EvalComplexity,
  EvalResult,
  EvalSummary,
  EvalToolMetrics,
  EvalToolStat,
} from "./types";

export async function writeEvalReport(
  outputDir: string,
  results: EvalResult[],
): Promise<EvalSummary> {
  await fs.mkdir(outputDir, { recursive: true });
  const startedAt = results[0]?.startedAt || new Date().toISOString();
  const finishedAt = results.at(-1)?.finishedAt || new Date().toISOString();

  for (const result of results) {
    const filePath = path.join(outputDir, `${result.scenarioId}.json`);
    await fs.writeFile(filePath, JSON.stringify(result, null, 2), "utf8");
  }

  const summary = buildSummary(outputDir, startedAt, finishedAt, results);
  await fs.writeFile(
    path.join(outputDir, "summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(outputDir, "summary.md"),
    renderSummaryMarkdown(summary),
    "utf8",
  );

  return summary;
}

export async function readLatestEvalSummary(
  outputDir: string,
): Promise<string | null> {
  const summaryPath = path.join(outputDir, "latest", "summary.md");
  try {
    return await fs.readFile(summaryPath, "utf8");
  } catch {
    return null;
  }
}

export async function publishLatestSummary(
  reportDir: string,
  outputDir: string,
): Promise<void> {
  const latestDir = path.join(outputDir, "latest");
  await fs.mkdir(latestDir, { recursive: true });

  await Promise.all([
    fs.copyFile(
      path.join(reportDir, "summary.md"),
      path.join(latestDir, "summary.md"),
    ),
    fs.copyFile(
      path.join(reportDir, "summary.json"),
      path.join(latestDir, "summary.json"),
    ),
  ]);
}

function buildSummary(
  outputDir: string,
  startedAt: string,
  finishedAt: string,
  results: EvalResult[],
): EvalSummary {
  const byComplexity: Record<
    EvalComplexity,
    { total: number; passed: number }
  > = {
    simple: { total: 0, passed: 0 },
    moderate: { total: 0, passed: 0 },
    complex: { total: 0, passed: 0 },
  };
  const failuresByKind: EvalSummary["failuresByKind"] = {};
  const toolMetrics = combineToolMetrics(
    results.map((result) => result.toolMetrics),
  );

  for (const result of results) {
    byComplexity[result.complexity].total += 1;
    if (result.passed) {
      byComplexity[result.complexity].passed += 1;
    } else if (result.failureKind) {
      failuresByKind[result.failureKind] =
        (failuresByKind[result.failureKind] || 0) + 1;
    }
  }

  return {
    startedAt,
    finishedAt,
    outputDir,
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    failuresByKind,
    byComplexity,
    toolMetrics,
    results: results.map((result) => ({
      scenarioId: result.scenarioId,
      title: result.title,
      passed: result.passed,
      failureKind: result.failureKind,
      complexity: result.complexity,
      durationMs: result.durationMs,
      toolMetrics: result.toolMetrics,
      workspacePath: result.workspacePath,
    })),
  };
}

function renderSummaryMarkdown(summary: EvalSummary): string {
  const lines = [
    "# Miniclaw Eval Summary",
    "",
    `- Started: ${summary.startedAt}`,
    `- Finished: ${summary.finishedAt}`,
    `- Total scenarios: ${summary.total}`,
    `- Passed: ${summary.passed}`,
    `- Failed: ${summary.failed}`,
    "",
    "## Tool Usage",
    "",
    `- Total calls: ${summary.toolMetrics.totalCalls}`,
    `- Successful calls: ${summary.toolMetrics.successfulCalls}`,
    `- Failed calls: ${summary.toolMetrics.failedCalls}`,
  ];

  if (summary.toolMetrics.byTool.length > 0) {
    lines.push("", "### Tools", "");
    for (const stat of summary.toolMetrics.byTool) {
      lines.push(
        `- ${stat.toolName}: ${stat.total} total (${stat.successful} success, ${stat.failed} failed)`,
      );
    }
  }

  if (summary.toolMetrics.skillReads.length > 0) {
    lines.push("", "### Skill Reads", "");
    for (const stat of summary.toolMetrics.skillReads) {
      lines.push(
        `- ${stat.toolName}: ${stat.total} total (${stat.successful} success, ${stat.failed} failed)`,
      );
    }
  }

  lines.push("", "## Complexity Breakdown", "");

  for (const [complexity, stats] of Object.entries(summary.byComplexity)) {
    lines.push(`- ${complexity}: ${stats.passed}/${stats.total} passed`);
  }

  lines.push("", "## Scenario Results", "");
  for (const result of summary.results) {
    lines.push(
      `- ${result.scenarioId}: ${result.passed ? "PASS" : "FAIL"} (${result.complexity}, ${result.durationMs} ms${result.failureKind ? `, ${result.failureKind}` : ""})`,
    );
    lines.push(
      `  tools: ${result.toolMetrics.totalCalls} total (${result.toolMetrics.successfulCalls} success, ${result.toolMetrics.failedCalls} failed)`,
    );
    if (result.workspacePath) {
      lines.push(`  workspace: ${result.workspacePath}`);
    }
  }

  return lines.join("\n");
}

function combineToolMetrics(metricsList: EvalToolMetrics[]): EvalToolMetrics {
  const stats = new Map<string, EvalToolStat>();

  let totalCalls = 0;
  let successfulCalls = 0;
  let failedCalls = 0;

  for (const metrics of metricsList) {
    totalCalls += metrics.totalCalls;
    successfulCalls += metrics.successfulCalls;
    failedCalls += metrics.failedCalls;

    for (const stat of metrics.byTool) {
      const current = stats.get(stat.toolName) || {
        toolName: stat.toolName,
        total: 0,
        successful: 0,
        failed: 0,
      };
      current.total += stat.total;
      current.successful += stat.successful;
      current.failed += stat.failed;
      stats.set(stat.toolName, current);
    }
  }

  const byTool = [...stats.values()].sort(
    (left, right) =>
      right.total - left.total || left.toolName.localeCompare(right.toolName),
  );

  return {
    totalCalls,
    successfulCalls,
    failedCalls,
    byTool,
    skillReads: byTool.filter((stat) => isSkillReadTool(stat.toolName)),
  };
}

function isSkillReadTool(toolName: string): boolean {
  return (
    toolName === "list_skills" ||
    toolName === "load_skill" ||
    toolName === "get_skill_info"
  );
}
