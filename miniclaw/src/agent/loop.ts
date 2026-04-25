import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import { buildSystemPrompt } from "./context";
import type { MessageBus } from "@/bus/index";
import type { PersistenceService } from "@/services/persistence";
import type { AppConfig } from "@/config/schema";
import { logger } from "@/utils/logger";
import { ulid } from "ulid";

// Ensure built-in pi-ai providers (OpenAI, Anthropic, etc.) are registered
registerBuiltInApiProviders();

export class AgentLoop {
  constructor(
    private readonly bus: MessageBus,
    private readonly persistence: PersistenceService,
    private readonly config: AppConfig,
  ) {}

  public start() {
    this.bus.subscribeInbound(async (event) => {
      try {
        await this.handleTurn(
          event.message.content as string,
          event.channel,
          event.userId,
        );
      } catch (err) {
        logger.error({ err }, "Agent loop turn failed");
      }
    });
  }

  private async handleTurn(
    userText: string,
    channel?: string,
    userId?: string,
  ) {
    const thread = await this.persistence.getConversationThread();

    // 1. Persist inbound user message
    await this.persistence.appendMessage(thread.id, {
      role: "user",
      content: userText,
      timestamp: Date.now(),
    });

    // 2. Load context
    const messages = await this.persistence.getMessages(thread.id);
    const systemPrompt = await buildSystemPrompt({
      workspacePath: this.config.workspace.path,
      channel,
    });

    // 3. Resolve Provider & API Key
    const providerStr = this.config.thread.provider as any;
    const modelIdStr = this.config.thread.modelId;
    let model;
    try {
      model = getModel(providerStr, modelIdStr as any);
    } catch {
      // Fallback if model not found in strict types
      model = {
        id: modelIdStr,
        name: modelIdStr,
        api:
          providerStr === "ollama" ? "openai-completions" : "openai-responses",
        provider: providerStr,
        baseUrl: providerStr === "ollama" ? "http://127.0.0.1:11434/v1" : "",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: this.config.thread.contextWindowTokens,
        maxTokens: this.config.thread.maxTokens,
      } as any;
    }

    const getApiKey = (provider: string) => {
      if (provider === "openai")
        return this.config.thread.apiKeys.openai || process.env.OPENAI_API_KEY;
      if (provider === "anthropic")
        return (
          this.config.thread.apiKeys.anthropic || process.env.ANTHROPIC_API_KEY
        );
      return undefined;
    };

    // 4. Initialize pi-agent-core Agent
    const agent = new Agent({
      initialState: {
        model,
        systemPrompt,
        messages,
        thinkingLevel: "off",
      },
      getApiKey,
      transformContext: async (msgs) => {
        // TODO: Summarization/Compaction logic will go here
        return msgs;
      },
    });

    // 5. Subscribe to agent streams for CLI / UI
    agent.subscribe(async (agentEvent) => {
      if (agentEvent.type === "message_update") {
        if (agentEvent.assistantMessageEvent.type === "text_delta") {
          this.bus.publishStreamDelta({
            id: ulid(),
            delta: agentEvent.assistantMessageEvent.delta,
            timestamp: Date.now(),
            channel,
            userId,
          });
        }
      }
    });

    // 6. Execute Turn
    logger.debug(`Starting agent turn (channel: ${channel || "unknown"})`);
    await agent.continue(); // This triggers the LLM using the loaded messages
    await agent.waitForIdle();

    // 7. Extract final response and sync to storage
    const updatedMessages = agent.state.messages;
    await this.persistence.saveMessages(thread.id, updatedMessages);

    const lastMsg = updatedMessages[updatedMessages.length - 1];
    if (lastMsg && lastMsg.role === "assistant") {
      this.bus.publishOutbound({
        message: lastMsg,
        channel,
        userId,
      });
    }
  }
}
