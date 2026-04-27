import { MemoryStore, MemoryEntry } from "../services/memory";
import { logger } from "../utils/logger";

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

export interface DreamConfig {
  maxMemoriesPerDream: number;
  minMessagesForDream: number;
}

export class DreamService {
  private readonly memoryStore: MemoryStore;
  private readonly config: DreamConfig;

  constructor(memoryStore: MemoryStore, config?: Partial<DreamConfig>) {
    this.memoryStore = memoryStore;
    this.config = {
      maxMemoriesPerDream: config?.maxMemoriesPerDream ?? 10,
      minMessagesForDream: config?.minMessagesForDream ?? 5,
    };
  }

  /**
   * Consolidate conversation messages into memories
   */
  async consolidate(messages: AgentMessage[]): Promise<MemoryEntry[]> {
    if (messages.length < this.config.minMessagesForDream) {
      logger.info(
        `Not enough messages for dream consolidation (${messages.length} < ${this.config.minMessagesForDream})`,
      );
      return [];
    }

    logger.info(`Starting dream consolidation for ${messages.length} messages`);

    // Generate memories from conversation
    const memories = await this.generateMemories(messages);

    // Save memories to store
    if (memories.length > 0) {
      await this.saveMemories(memories);
      logger.info(
        `Dream consolidation complete: ${memories.length} memories created`,
      );
    } else {
      logger.info("Dream consolidation complete: no memories extracted");
    }

    return memories;
  }

  /**
   * Generate memory entries from conversation messages
   */
  private async generateMemories(
    messages: AgentMessage[],
  ): Promise<MemoryEntry[]> {
    // This is a simplified implementation
    // In a real implementation, you would use an LLM to analyze the conversation
    // and extract valuable facts, preferences, and information

    const memories: MemoryEntry[] = [];
    const content = messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");

    // Extract facts from conversation
    // This is a placeholder - real implementation would use LLM
    const facts = this.extractFacts(content);

    for (const fact of facts) {
      if (memories.length >= this.config.maxMemoriesPerDream) {
        break;
      }

      memories.push({
        id: this.generateId(),
        content: fact.content,
        tags: fact.tags,
        createdAt: new Date().toISOString(),
        source: "dream",
      });
    }

    return memories;
  }

  /**
   * Save memories to the memory store
   */
  private async saveMemories(memories: MemoryEntry[]): Promise<void> {
    for (const memory of memories) {
      await this.memoryStore.addMemory(memory.content, memory.tags, "dream");
    }
  }

  /**
   * Extract facts from conversation content
   * This is a simplified implementation - real version would use LLM
   */
  private extractFacts(
    content: string,
  ): Array<{ content: string; tags: string[] }> {
    const facts: Array<{ content: string; tags: string[] }> = [];

    // Simple pattern matching for facts
    // In production, this would be replaced with LLM-based extraction

    // Look for preferences
    const preferencePatterns = [
      /(?:i prefer|i like|i'd like|i want)\s+(.+)/gi,
      /(?:my preference is|my favorite is)\s+(.+)/gi,
    ];

    for (const pattern of preferencePatterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        if (match[1]) {
          facts.push({
            content: `User preference: ${match[1].trim()}`,
            tags: ["preference", "user"],
          });
        }
      }
    }

    // Look for important information
    const infoPatterns = [
      /(?:remember|don't forget|important)\s+(.+)/gi,
      /(?:my name is|i'm|i am)\s+(\w+)/gi,
    ];

    for (const pattern of infoPatterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        if (match[1]) {
          facts.push({
            content: `Important: ${match[1].trim()}`,
            tags: ["important", "fact"],
          });
        }
      }
    }

    // Look for tasks or commitments
    const taskPatterns = [
      /(?:i need to|i have to|i should|i'll|i will)\s+(.+)/gi,
      /(?:todo|task|reminder):\s*(.+)/gi,
    ];

    for (const pattern of taskPatterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        if (match[1]) {
          facts.push({
            content: `Task/commitment: ${match[1].trim()}`,
            tags: ["task", "commitment"],
          });
        }
      }
    }

    return facts;
  }

  /**
   * Generate a unique ID for memories
   */
  private generateId(): string {
    return `dream_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
