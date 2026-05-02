import type { GoalService } from "../services/goals";
import type { UserProfileService } from "../services/user_profile";
import type { WorkspaceMemoryService } from "../services/workspace_memory";
import { logger } from "../utils/logger";

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

export interface DreamConfig {
  minMessagesForDream: number;
}

export interface DreamResult {
  addedPreferences: string[];
  addedFacts: string[];
  memoryEntriesRecorded: string[];
  goalUpdates: string[];
}

export class DreamService {
  private readonly config: DreamConfig;

  constructor(
    private readonly userProfileService: UserProfileService,
    private readonly goalService: GoalService,
    private readonly workspaceMemoryService: WorkspaceMemoryService,
    config?: Partial<DreamConfig>,
  ) {
    this.config = {
      minMessagesForDream: config?.minMessagesForDream ?? 5,
    };
  }

  async consolidate(messages: AgentMessage[]): Promise<DreamResult> {
    if (messages.length < this.config.minMessagesForDream) {
      logger.info(
        `Not enough messages for dream consolidation (${messages.length} < ${this.config.minMessagesForDream})`,
      );
      return emptyDreamResult();
    }

    logger.info(`Starting dream consolidation for ${messages.length} messages`);

    const result = emptyDreamResult();
    const activeGoals = await this.goalService.listGoals("active");

    for (const message of messages) {
      if (message.role !== "user") continue;

      for (const preference of extractPreferences(message.content)) {
        await this.userProfileService.addPreference(preference);
        result.addedPreferences.push(preference);
      }

      for (const fact of extractStableFacts(message.content)) {
        await this.userProfileService.addStableFact(fact);
        result.addedFacts.push(fact);
      }

      for (const memoryEntry of extractWorkspaceMemoryEntries(
        message.content,
      )) {
        await this.workspaceMemoryService.recordEntry(memoryEntry);
        result.memoryEntriesRecorded.push(memoryEntry.summary);
      }

      for (const goal of activeGoals) {
        if (referencesGoal(message.content, goal.title)) {
          await this.goalService.recordProgress({
            goalId: goal.id,
            summary: message.content,
            source: "dream",
          });
          result.goalUpdates.push(goal.id);
        }
      }
    }

    logger.info(
      `Dream consolidation complete: ${result.addedPreferences.length + result.addedFacts.length + result.memoryEntriesRecorded.length + result.goalUpdates.length} structured updates`,
    );

    return result;
  }
}

function emptyDreamResult(): DreamResult {
  return {
    addedPreferences: [],
    addedFacts: [],
    memoryEntriesRecorded: [],
    goalUpdates: [],
  };
}

function extractPreferences(content: string): string[] {
  const matches: string[] = [];
  const patterns = [/(?:i prefer|i like|my preference is)\s+(.+)/gi];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]?.trim()) {
        matches.push(match[1].trim());
      }
    }
  }

  return unique(matches);
}

function extractStableFacts(content: string): string[] {
  const facts: string[] = [];
  const nameMatch = content.match(/(?:my name is|i am)\s+([A-Za-z][\w-]*)/i);
  if (nameMatch?.[0]) {
    facts.push(nameMatch[0].trim());
  }
  return unique(facts);
}

function extractWorkspaceMemoryEntries(content: string): Array<{
  category: "decision" | "convention" | "constraint" | "attempt_outcome";
  summary: string;
  tags?: string[];
  source?: string;
}> {
  const entries: Array<{
    category: "decision" | "convention" | "constraint" | "attempt_outcome";
    summary: string;
    tags?: string[];
    source?: string;
  }> = [];

  const trimmed = content.trim();
  if (!trimmed) {
    return entries;
  }

  if (/^(?:we decided|let'?s use|we will use)\b/i.test(trimmed)) {
    entries.push({
      category: "decision",
      summary: trimmed,
      source: "dream",
    });
  } else if (
    /\b(?:constraint|cannot|can't|must use|must not|only)\b/i.test(trimmed)
  ) {
    entries.push({
      category: "constraint",
      summary: trimmed,
      source: "dream",
    });
  } else if (
    /\b(?:worked|didn't work|failed|succeeded|success)\b/i.test(trimmed)
  ) {
    entries.push({
      category: "attempt_outcome",
      summary: trimmed,
      source: "dream",
    });
  } else if (/\b(?:usually|by default|convention|workflow)\b/i.test(trimmed)) {
    entries.push({
      category: "convention",
      summary: trimmed,
      source: "dream",
    });
  }

  return entries;
}

function referencesGoal(content: string, goalTitle: string): boolean {
  return content.toLowerCase().includes(goalTitle.toLowerCase());
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
