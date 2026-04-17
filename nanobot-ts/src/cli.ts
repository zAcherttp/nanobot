#!/usr/bin/env node
import { main } from "./cli/commands.js";

const isMainModule =
	process.argv[1] !== undefined &&
	new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href ===
		import.meta.url;

if (isMainModule) {
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exitCode = 1;
	});
}
