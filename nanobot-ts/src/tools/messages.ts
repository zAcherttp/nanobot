export class ToolInputError extends Error {
	override readonly name = "ToolInputError";
}

export function isToolInputError(error: unknown): error is ToolInputError {
	return error instanceof ToolInputError;
}

export function toolInvalidRequestMessage(
	tool: string,
	reason: string,
	guidance = "Fix the tool arguments and retry if the user request still requires this operation.",
): string {
	return [`Cannot run ${tool}: ${reason}`, guidance].join("\n");
}

export function toolDisabledByUserConfigMessage(
	capability: string,
	guidance = "Do not retry this action unless the user enables it in config.",
): string {
	return [`${capability} is disabled by user config.`, guidance].join("\n");
}

export function toolUnavailableMessage(options: {
	tool: string;
	target?: string | undefined;
	reason?: string | undefined;
	guidance?: string | undefined;
}): string {
	const target = options.target ? ` for: ${options.target}` : "";
	const reason =
		options.reason?.trim() || "the backend failed or blocked the request";
	return [
		`${options.tool} is temporarily unavailable${target}.`,
		`The operation could not be completed because ${reason}.`,
		options.guidance ??
			"Do not treat this as evidence that the requested data does not exist. Use existing context if sufficient, or tell the user to retry later.",
	].join("\n");
}
