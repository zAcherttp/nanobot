import { Agent } from "@mariozechner/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type Usage,
} from "@mariozechner/pi-ai";

interface SessionRecord {
	chatId: string;
	turns: string[];
	agent: Agent;
}

const STUB_MODEL: Model<"openai-completions"> = {
	id: "nanobot-ts-stub",
	name: "nanobot-ts-stub",
	api: "openai-completions",
	provider: "nanobot-ts",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 8192,
	maxTokens: 1024,
};

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

export class AgentLoop {
	private readonly sessions = new Map<string, SessionRecord>();

	getSessionCount(): number {
		return this.sessions.size;
	}

	hasSession(chatId: string): boolean {
		return this.sessions.has(chatId);
	}

	async reply(chatId: string, userMessage: string): Promise<string> {
		const session = this.getOrCreateSession(chatId);
		session.turns.push(userMessage);
		await session.agent.prompt(userMessage);
		return getAssistantReplyText(session.agent) ?? `you said : ${userMessage}`;
	}

	private getOrCreateSession(chatId: string): SessionRecord {
		const existing = this.sessions.get(chatId);
		if (existing) {
			return existing;
		}

		const created: SessionRecord = {
			chatId,
			turns: [],
			agent: this.instantiateAgent(),
		};
		this.sessions.set(chatId, created);
		return created;
	}

	private instantiateAgent(): Agent {
		return new Agent({
			initialState: {
				systemPrompt: "You are a deterministic echo agent.",
				model: STUB_MODEL,
			},
			streamFn: (model, context) => createStubStream(model, context),
		});
	}
}

function createStubStream(model: Model<Api>, context: Context) {
	const stream = createAssistantMessageEventStream();
	const replyText = `you said : ${getLastUserText(context.messages)}`;
	const finalMessage: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: replyText }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};

	queueMicrotask(() => {
		stream.push({ type: "start", partial: finalMessage });
		stream.push({ type: "text_start", contentIndex: 0, partial: finalMessage });
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: replyText,
			partial: finalMessage,
		});
		stream.push({
			type: "text_end",
			contentIndex: 0,
			content: replyText,
			partial: finalMessage,
		});
		stream.push({
			type: "done",
			reason: "stop",
			message: finalMessage,
		});
	});

	return stream;
}

function getLastUserText(messages: Context["messages"]): string {
	const last = [...messages]
		.reverse()
		.find((message) => message.role === "user");
	if (!last) {
		return "";
	}
	if (typeof last.content === "string") {
		return last.content;
	}
	return last.content
		.filter(
			(
				item,
			): item is Extract<(typeof last.content)[number], { type: "text" }> =>
				item.type === "text",
		)
		.map((item) => item.text)
		.join("\n");
}

function getAssistantReplyText(agent: Agent): string | null {
	const last = [...agent.state.messages]
		.reverse()
		.find((message) => message.role === "assistant");
	if (!last || !("content" in last) || !Array.isArray(last.content)) {
		return null;
	}

	const parts = last.content
		.filter(
			(
				item,
			): item is Extract<(typeof last.content)[number], { type: "text" }> =>
				item.type === "text",
		)
		.map((item) => item.text);

	return parts.length > 0 ? parts.join("") : null;
}
