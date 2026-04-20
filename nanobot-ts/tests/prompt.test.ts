import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	buildSystemPrompt,
	extractConfirmedUserHeuristics,
} from "../src/agent/prompt.js";
import { syncWorkspaceTemplates } from "../src/templates/index.js";

describe("prompt composer", () => {
	it("keeps only confirmed heuristics from USER.md", () => {
		const content = [
			"# User",
			"",
			"Ignore this line.",
			"",
			"## Confirmed behavioral heuristics",
			"",
			"- Prefer concise replies.",
			"- Prefer direct answers.",
			"",
			"## Draft notes",
			"",
			"- Ignore this too.",
		].join("\n");

		expect(extractConfirmedUserHeuristics(content)).toBe(
			[
				"## Confirmed behavioral heuristics",
				"",
				"- Prefer concise replies.",
				"- Prefer direct answers.",
			].join("\n"),
		);
	});

	it("builds a system prompt from templates, bootstrap files, summary, and selected skills", async () => {
		const workspace = await mkdtemp(
			path.join(os.tmpdir(), "nanobot-ts-prompt-"),
		);
		await syncWorkspaceTemplates(workspace);
		await writeFile(
			path.join(workspace, "AGENTS.md"),
			"# Agents\n\nFollow repo-specific rules.\n",
			"utf8",
		);
		await writeFile(
			path.join(workspace, "USER.md"),
			[
				"# User",
				"",
				"Do not include this sentence.",
				"",
				"## Confirmed behavioral heuristics",
				"",
				"- Keep answers short.",
			].join("\n"),
			"utf8",
		);
		await mkdir(path.join(workspace, "skills", "custom"), { recursive: true });
		await writeFile(
			path.join(workspace, "skills", "custom", "SKILL.md"),
			[
				"---",
				"description: Custom workspace skill",
				"---",
				"",
				"# Custom",
				"",
				"Use this custom skill.",
			].join("\n"),
			"utf8",
		);

		const prompt = await buildSystemPrompt({
			workspacePath: workspace,
			selectedSkills: ["custom"],
			channel: "telegram",
		});

		expect(prompt).toContain("You are nanobot");
		expect(prompt).toContain("Follow repo-specific rules.");
		expect(prompt).toContain("## Confirmed behavioral heuristics");
		expect(prompt).toContain("- Keep answers short.");
		expect(prompt).not.toContain("Do not include this sentence.");
		expect(prompt).toContain("<skills>");
		expect(prompt).toContain("<name>custom</name>");
		expect(prompt).toContain("### Skill: custom");
		expect(prompt).toContain("Use this custom skill.");
		expect(prompt).not.toContain("### Skill: summarize");
		expect(prompt).toContain("messaging app");
	});

	it("returns empty string when USER.md has no confirmed heuristics section", () => {
		const content = [
			"# User",
			"",
			"Some unstructured notes.",
			"",
			"## Draft notes",
			"",
			"- This should not appear.",
		].join("\n");

		expect(extractConfirmedUserHeuristics(content)).toBe("");
	});

	it("includes SOUL.md personality traits in the system prompt", async () => {
		const workspace = await mkdtemp(
			path.join(os.tmpdir(), "nanobot-ts-prompt-"),
		);
		await syncWorkspaceTemplates(workspace);
		await writeFile(
			path.join(workspace, "SOUL.md"),
			"# Personality\n\nBe cheerful and encouraging.\n",
			"utf8",
		);

		const prompt = await buildSystemPrompt({
			workspacePath: workspace,
		});

		expect(prompt).toContain("Be cheerful and encouraging.");
	});

	it("includes terminal format hint for CLI channel", async () => {
		const workspace = await mkdtemp(
			path.join(os.tmpdir(), "nanobot-ts-prompt-"),
		);
		await syncWorkspaceTemplates(workspace);

		const prompt = await buildSystemPrompt({
			workspacePath: workspace,
			channel: "cli",
		});

		expect(prompt).toContain("terminal");
		expect(prompt).not.toContain("messaging app");
	});
});
