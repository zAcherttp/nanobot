import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it } from "vitest";

import { createWorkspaceTools } from "../src/tools/index.js";

describe("workspace tools", () => {
	let workspace: string;
	let tools: AgentTool[];

	beforeEach(async () => {
		workspace = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-tools-"));
		tools = createWorkspaceTools({
			workspacePath: workspace,
			allowWrites: true,
			maxReadChars: 1_000,
			maxSearchResults: 10,
		});
	});

	it("reads text files with line numbers and rejects workspace escape", async () => {
		await writeFile(
			path.join(workspace, "notes.md"),
			"one\ntwo\nthree",
			"utf8",
		);

		const read = getTool(tools, "read_file");
		const text = await resultText(
			read.execute("call-1", { path: "notes.md", offset: 2, limit: 1 }),
		);
		const escaped = await resultText(
			read.execute("call-2", { path: "../outside.md" }),
		);

		expect(text).toBe("2|two\n\n(truncated, 1 lines omitted)");
		expect(escaped).toContain("Path escapes workspace");
	});

	it("writes and edits files only when write tools are enabled", async () => {
		const write = getTool(tools, "write_file");
		const edit = getTool(tools, "edit_file");

		await resultText(
			write.execute("call-1", { path: "docs/a.txt", content: "alpha beta" }),
		);
		const editText = await resultText(
			edit.execute("call-2", {
				path: "docs/a.txt",
				old_text: "beta",
				new_text: "gamma",
			}),
		);

		expect(editText).toContain("Successfully edited");
		expect(await readFile(path.join(workspace, "docs", "a.txt"), "utf8")).toBe(
			"alpha gamma",
		);

		const readOnlyTools = createWorkspaceTools({
			workspacePath: workspace,
			allowWrites: false,
			maxReadChars: 1_000,
			maxSearchResults: 10,
		});
		expect(readOnlyTools.map((tool) => tool.name)).not.toContain("write_file");
		expect(readOnlyTools.map((tool) => tool.name)).not.toContain("edit_file");
	});

	it("lists, globs, and greps workspace files with bounded results", async () => {
		await mkdir(path.join(workspace, "src"), { recursive: true });
		await writeFile(
			path.join(workspace, "src", "a.ts"),
			"export const a = 1;\n",
			"utf8",
		);
		await writeFile(
			path.join(workspace, "src", "b.md"),
			"alpha\nbeta\n",
			"utf8",
		);

		const listText = await resultText(
			getTool(tools, "list_dir").execute("call-1", {
				path: ".",
				recursive: true,
			}),
		);
		const globText = await resultText(
			getTool(tools, "glob").execute("call-2", {
				path: ".",
				pattern: "**/*.ts",
			}),
		);
		const grepText = await resultText(
			getTool(tools, "grep").execute("call-3", {
				path: ".",
				pattern: "alpha",
				output_mode: "content",
			}),
		);

		expect(listText).toContain("src/a.ts");
		expect(globText).toContain("src/a.ts");
		expect(grepText).toContain("src/b.md:1");
		expect(grepText).toContain("> 1| alpha");
	});
});

function getTool(tools: AgentTool[], name: string): AgentTool {
	const tool = tools.find((entry) => entry.name === name);
	if (!tool) {
		throw new Error(`Missing tool ${name}`);
	}
	return tool;
}

async function resultText(result: Promise<unknown>): Promise<string> {
	const resolved = (await result) as {
		content: Array<{ type: "text"; text: string }>;
	};
	return resolved.content[0]?.text ?? "";
}
