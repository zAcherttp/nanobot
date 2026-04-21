import type { AgentTool } from "@mariozechner/pi-agent-core";

import type { AppConfig } from "../config/schema.js";
import { type CronService, createCronTool } from "../cron/index.js";
import {
	getNanobotFauxTools,
	isNanobotFauxProvider,
} from "../providers/faux.js";
import {
	type CalendarProvider,
	createCalendarTool,
	createConfiguredCalendarProvider,
} from "./calendar/index.js";
import { createWebTools } from "./web.js";
import { createWorkspaceTools } from "./workspace.js";

export interface RuntimeToolFactoryOptions {
	config: AppConfig;
	cronService?: CronService;
	channel?: string;
	chatId?: string;
	inCronContext?: boolean;
	calendarProvider?: CalendarProvider;
}

const WORKSPACE_TOOL_NAMES = new Set([
	"read_file",
	"write_file",
	"edit_file",
	"list_dir",
	"glob",
	"grep",
]);
const WEB_TOOL_NAMES = new Set(["web_search", "web_fetch"]);

export function createRuntimeTools(
	options: RuntimeToolFactoryOptions,
): AgentTool[] {
	const { config } = options;
	const tools: AgentTool[] = [];

	if (isNanobotFauxProvider(config.agent.provider)) {
		tools.push(...getNanobotFauxTools());
	}

	if (config.tools.workspace.enabled) {
		tools.push(
			...createWorkspaceTools({
				workspacePath: config.workspace.path,
				allowWrites: config.tools.workspace.allowWrites,
				maxReadChars: config.tools.workspace.maxReadChars,
				maxSearchResults: config.tools.workspace.maxSearchResults,
			}),
		);
	}

	if (config.tools.web.enabled) {
		tools.push(
			...createWebTools({
				config: config.tools.web,
				ssrfWhitelist: config.security.ssrfWhitelist,
			}),
		);
	}

	if (options.cronService && config.cron.enabled) {
		tools.push(
			createCronTool({
				service: options.cronService,
				defaultTimeZone: config.cron.timezone,
				...(options.channel ? { channel: options.channel } : {}),
				...(options.chatId ? { chatId: options.chatId } : {}),
				...(options.inCronContext ? { inCronContext: true } : {}),
			}),
		);
	}

	if (config.tools.calendar.enabled) {
		tools.push(
			createCalendarTool({
				provider:
					options.calendarProvider ??
					createConfiguredCalendarProvider(config.tools.calendar),
				allowWrites: config.tools.calendar.allowWrites,
				defaultCalendarId: config.tools.calendar.defaultCalendarId,
			}),
		);
	}

	return filterTools(tools, config.tools.enabled);
}

export function filterTools(
	tools: AgentTool[],
	enabled: string[],
): AgentTool[] {
	if (enabled.includes("*")) {
		return tools;
	}
	if (enabled.length === 0) {
		return [];
	}

	const enabledSet = new Set(enabled);
	return tools.filter((tool) => {
		if (enabledSet.has(tool.name)) {
			return true;
		}
		if (enabledSet.has("workspace") && WORKSPACE_TOOL_NAMES.has(tool.name)) {
			return true;
		}
		if (enabledSet.has("web") && WEB_TOOL_NAMES.has(tool.name)) {
			return true;
		}
		if (enabledSet.has("calendar") && tool.name === "calendar") {
			return true;
		}
		return enabledSet.has("cron") && tool.name === "cron";
	});
}
