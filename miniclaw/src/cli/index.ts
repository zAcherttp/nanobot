import { defineCommand } from "citty";

export const mainCommand = defineCommand({
	meta: {
		name: "miniclaw",
		version: "1.0.0",
		description: "Next generation core of nanobot",
	},
	subCommands: {
		gateway: () => import("./commands/gateway.js").then((r) => r.default),
	},
});
