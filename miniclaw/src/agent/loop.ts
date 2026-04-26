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

const INBOUND_LOG_PREVIEW_CHARS = 120;
const OUTBOUND_LOG_PREVIEW_CHARS = 120;

export class AgentLoop {
  constructor(
    private readonly bus: MessageBus,
    private readonly persistence: PersistenceService,
    private readonly config: AppConfig,
  ) {}

  public start() {
    this.bus.subscribeInbound(async (event) => {
      const busReceivedAt = Date.now();
      try {
        await this.handleTurn(
          event.message.content as string,
          event.channel,
          event.userId,
          busReceivedAt,
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
    busReceivedAt?: number,
  ) {
    logger.info(
      {
        channel: channel || "unknown",
        userId: userId || "anonymous",
        content: this.truncateForLog(userText, INBOUND_LOG_PREVIEW_CHARS),
      },
      "Gateway message received",
    );

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
      // Ignored
    }

    // Provider configuration
    const providerConfig = {
      ollama: {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
      nvidia: {
        api: "openai-responses",
        baseUrl: "https://integrate.api.nvidia.com/v1",
      },
    };

    if (!model) {
      // Fallback if model not found in strict types
      const config = providerConfig[providerStr as keyof typeof providerConfig];
      model = {
        id: modelIdStr,
        name: modelIdStr,
        api: config?.api || "openai-responses",
        provider: providerStr,
        baseUrl: config?.baseUrl || "",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: this.config.thread.contextWindowTokens,
        maxTokens: this.config.thread.maxTokens,
      } as any;
    }

    const apiKeyEnvMap: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      ollama: "OLLAMA_API_KEY",
      nvidia: "NVIDIA_API_KEY",
    };

    const getApiKey = (provider: string) => {
      const configKey =
        this.config.thread.apiKeys[
          provider as keyof typeof this.config.thread.apiKeys
        ];
      const envKey = apiKeyEnvMap[provider];
      const apiKey = configKey || (envKey ? process.env[envKey] : undefined);
      // Ollama defaults to "ollama" if no key is provided
      return apiKey || (provider === "ollama" ? "ollama" : undefined);
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

    const streamId = ulid();
    let firstTokenLogged = false;

    // 5. Subscribe to agent streams for CLI / UI
    agent.subscribe(async (agentEvent) => {
      if (agentEvent.type === "message_update") {
        if (agentEvent.assistantMessageEvent.type === "text_delta") {
          if (!firstTokenLogged && typeof busReceivedAt === "number") {
            firstTokenLogged = true;
            const latencyMs = Date.now() - busReceivedAt;
            logger.debug(
              `Time from bus receive to first streamed token: ${latencyMs} ms`,
            );
          }

          this.bus.publishStreamDelta({
            id: streamId,
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

    if (!firstTokenLogged && typeof busReceivedAt === "number") {
      const latencyMs = Date.now() - busReceivedAt;
      logger.debug(
        `No streamed token emitted before turn completion: ${latencyMs} ms`,
      );
    }

    // 7. Extract final response and sync to storage
    const updatedMessages = agent.state.messages;
    await this.persistence.saveMessages(thread.id, updatedMessages);

    const lastMsg = updatedMessages[updatedMessages.length - 1];
    if (lastMsg && lastMsg.role === "assistant") {
      const responseText = this.extractTextContent(lastMsg.content);
      logger.info(
        {
          channel: channel || "unknown",
          userId: userId || "anonymous",
          content: this.truncateForLog(
            responseText,
            OUTBOUND_LOG_PREVIEW_CHARS,
          ),
        },
        "Agent response",
      );

      this.bus.publishOutbound({
        message: lastMsg,
        channel,
        userId,
      });
    }
  }

  private extractTextContent(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    return content
      .map((part) => {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          (part as { type?: unknown }).type === "text" &&
          "text" in part
        ) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }

        return "[non-text-content]";
      })
      .join("\n")
      .trim();
  }

  private truncateForLog(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
      return text;
    }

    return `${text.slice(0, maxChars)}...`;
  }
}
