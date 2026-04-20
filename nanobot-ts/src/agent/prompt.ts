import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SkillsLoader } from "../skills/index.js";
import { renderTemplate } from "../templates/index.js";

const BOOTSTRAP_FILES = [
	"AGENTS.md",
	"SOUL.md",
	"USER.md",
	"TOOLS.md",
] as const;
const USER_HEURISTICS_HEADER = "## Confirmed behavioral heuristics";

export interface BuildSystemPromptOptions {
	workspacePath: string;
	selectedSkills?: string[];
	channel?: string;
}

export async function buildSystemPrompt(
	options: BuildSystemPromptOptions,
): Promise<string> {
	const loader = new SkillsLoader(options.workspacePath);
	const parts: string[] = [
		await renderTemplate("agent/identity.md", {
			runtime: buildRuntimeLabel(),
			workspacePath: path.resolve(options.workspacePath),
			channelHint: buildChannelHint(options.channel),
		}),
	];

	const bootstrap = await loadBootstrapFiles(options.workspacePath);
	if (bootstrap) {
		parts.push(bootstrap);
	}

	const skillsSummary = await loader.buildSkillsSummary();
	if (skillsSummary) {
		parts.push(
			await renderTemplate("agent/skills_section.md", {
				skillsSummary,
			}),
		);
	}

	const selectedSkillsContent = await loader.loadSkillsForContext(
		options.selectedSkills ?? [],
	);
	if (selectedSkillsContent) {
		parts.push(`# Selected Skills\n\n${selectedSkillsContent}`);
	}

	return parts.filter(Boolean).join("\n\n---\n\n");
}

export function extractConfirmedUserHeuristics(content: string): string {
	const lines = content.split(/\r?\n/);
	const bullets: string[] = [];
	let inSection = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("## ")) {
			inSection = trimmed === USER_HEURISTICS_HEADER;
			continue;
		}

		if (!inSection) {
			continue;
		}

		if (trimmed.startsWith("- ")) {
			bullets.push(line);
		}
	}

	if (bullets.length === 0) {
		return "";
	}

	return `${USER_HEURISTICS_HEADER}\n\n${bullets.join("\n")}`;
}

async function loadBootstrapFiles(workspacePath: string): Promise<string> {
	const parts: string[] = [];

	for (const filename of BOOTSTRAP_FILES) {
		const filePath = path.join(workspacePath, filename);
		if (!(await pathExists(filePath))) {
			continue;
		}

		let content = await fs.readFile(filePath, "utf8");
		if (filename === "USER.md") {
			content = extractConfirmedUserHeuristics(content);
		}

		if (!content.trim()) {
			continue;
		}

		parts.push(`## ${filename}\n\n${content.trim()}`);
	}

	return parts.join("\n\n");
}

function buildRuntimeLabel(): string {
	return `${os.type()} ${os.arch()}, Node ${process.versions.node}`;
}

function buildChannelHint(channel?: string): string {
	switch (channel) {
		case "telegram":
		case "qq":
		case "discord":
			return "## Format Hint\nThis conversation is on a messaging app. Use short paragraphs. Avoid tables and oversized headings.";
		case "whatsapp":
		case "sms":
			return "## Format Hint\nThis conversation is on a plain text messaging platform. Use plain text only.";
		case "email":
			return "## Format Hint\nThis conversation is via email. Use simple sections and keep formatting conservative.";
		case "cli":
		case "mochat":
			return "## Format Hint\nOutput is rendered in a terminal. Avoid markdown headings and tables.";
		default:
			return "";
	}
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath);
		return true;
	} catch {
		return false;
	}
}
