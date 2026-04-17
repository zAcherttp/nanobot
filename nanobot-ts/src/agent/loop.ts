interface SessionRecord {
	chatId: string;
	turns: string[];
}

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
		return "";
	}

	private getOrCreateSession(chatId: string): SessionRecord {
		const existing = this.sessions.get(chatId);
		if (existing) {
			return existing;
		}

		const created: SessionRecord = {
			chatId,
			turns: [],
		};
		this.sessions.set(chatId, created);
		return created;
	}
}
