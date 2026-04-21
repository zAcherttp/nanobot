import type { AppConfig } from "../../config/schema.js";
import { GwsCalendarProvider } from "./gws.js";
import { LarkCalendarProvider } from "./lark.js";
import type { CalendarProvider } from "./types.js";

export function createConfiguredCalendarProvider(
	config: AppConfig["tools"]["calendar"],
): CalendarProvider {
	if (config.provider === "lark") {
		return new LarkCalendarProvider({
			appId: config.lark.appId,
			appSecret: config.lark.appSecret,
			defaultCalendarId: config.lark.calendarId || config.defaultCalendarId,
			baseUrl: config.lark.baseUrl,
		});
	}

	return new GwsCalendarProvider({
		command: config.gws.command,
		defaultCalendarId: config.defaultCalendarId,
	});
}
