import type { AgentTool } from "@mariozechner/pi-agent-core";

import {
	createSessionAgent,
	getLatestAssistantText,
	type ResolvedAgentRuntimeConfig,
	retainRecentLegalSuffix,
	type SessionStore,
} from "../agent/loop.js";
import type { BackgroundTarget } from "../background/index.js";

export async function runHeartbeatTasks(options: {
	config: ResolvedAgentRuntimeConfig;
	sessionStore: SessionStore;
	tasks: string;
	keepRecentMessages: number;
	target: BackgroundTarget | null;
	tools: AgentTool[];
}): Promise<string> {
	const agent = await createSessionAgent({
		config: options.config,
		sessionKey: "heartbeat",
		...(options.target?.channel ? { channel: options.target.channel } : {}),
		sessionStore: options.sessionStore,
		tools: options.tools,
	});

	await agent.prompt(options.tasks);
	const response = getLatestAssistantText(agent.state.messages).trim();

	const persisted = await options.sessionStore.load("heartbeat");
	if (persisted) {
		await options.sessionStore.save({
			...persisted,
			messages: retainRecentLegalSuffix(
				persisted.messages,
				options.keepRecentMessages,
			),
		});
	}

	return response;
}
