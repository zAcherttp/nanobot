import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	renderTemplate,
	syncWorkspaceTemplates,
} from "../src/templates/index.js";

describe("templates", () => {
	it("renders bundled templates with placeholder substitution", async () => {
		const rendered = await renderTemplate("agent/identity.md", {
			runtime: "Test Runtime",
			workspacePath: "E:/tmp/workspace",
			channelHint: "## Format Hint\nShort replies only.",
		});

		expect(rendered).toContain("Test Runtime");
		expect(rendered).toContain("E:/tmp/workspace");
		expect(rendered).toContain("Short replies only.");
	});

	it("syncs missing workspace templates without overwriting existing files", async () => {
		const workspace = await mkdtemp(
			path.join(os.tmpdir(), "nanobot-ts-template-"),
		);
		const existingUser = path.join(workspace, "USER.md");
		await writeFile(existingUser, "# User\n\ncustom\n", "utf8");

		const added = await syncWorkspaceTemplates(workspace);

		expect(added).toEqual(
			expect.arrayContaining([
				"AGENTS.md",
				"SOUL.md",
				"TOOLS.md",
				"HEARTBEAT.md",
				"memory/MEMORY.md",
				"memory/history.jsonl",
			]),
		);
		expect(added).not.toContain("USER.md");
		expect(await readFile(existingUser, "utf8")).toBe("# User\n\ncustom\n");
		expect(await readFile(path.join(workspace, "AGENTS.md"), "utf8")).toContain(
			"# Agents",
		);
		expect(
			await readFile(path.join(workspace, "memory", "MEMORY.md"), "utf8"),
		).toContain("# Memory");
		expect(
			await readFile(path.join(workspace, "HEARTBEAT.md"), "utf8"),
		).toContain("# Heartbeat");
		expect(
			await readFile(path.join(workspace, "memory", "history.jsonl"), "utf8"),
		).toBe("");
	});
});
