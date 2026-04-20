import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { getPackageRoot } from "../config/paths.js";

export interface SkillMetadata {
	description?: string;
	requires?: {
		bins?: string[];
		env?: string[];
	};
}

export interface SkillEntry {
	name: string;
	path: string;
	source: "workspace" | "builtin";
	available: boolean;
	description: string;
	missingRequirements: string[];
}

export interface SkillsLoaderOptions {
	builtinSkillsDir?: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export class SkillsLoader {
	private readonly workspaceSkillsDir: string;
	private readonly builtinSkillsDir: string;

	constructor(workspacePath: string, options: SkillsLoaderOptions = {}) {
		this.workspaceSkillsDir = path.join(workspacePath, "skills");
		this.builtinSkillsDir =
			options.builtinSkillsDir ?? path.join(getPackageRoot(), "skills");
	}

	async listSkills(filterUnavailable = true): Promise<SkillEntry[]> {
		const workspaceEntries = await this.listFromDir(
			this.workspaceSkillsDir,
			"workspace",
		);
		const workspaceNames = new Set(workspaceEntries.map((entry) => entry.name));
		const builtinEntries = await this.listFromDir(
			this.builtinSkillsDir,
			"builtin",
			workspaceNames,
		);
		const entries = [...workspaceEntries, ...builtinEntries];
		return filterUnavailable
			? entries.filter((entry) => entry.available)
			: entries;
	}

	async loadSkill(name: string): Promise<string | null> {
		const record = await this.findSkill(name);
		if (!record) {
			return null;
		}

		return fs.readFile(record.path, "utf8");
	}

	async loadSkillsForContext(names: string[]): Promise<string> {
		const parts: string[] = [];
		const uniqueNames = [...new Set(names)];

		for (const name of uniqueNames) {
			const record = await this.findSkill(name);
			if (!record) {
				continue;
			}

			const availability = await this.describeSkill(record);
			if (!availability.available) {
				continue;
			}

			const raw = await fs.readFile(record.path, "utf8");
			parts.push(`### Skill: ${name}\n\n${stripFrontmatter(raw)}`);
		}

		return parts.join("\n\n---\n\n");
	}

	async buildSkillsSummary(): Promise<string> {
		const entries = await this.listSkills(false);
		if (entries.length === 0) {
			return "";
		}

		const lines: string[] = ["<skills>"];
		for (const entry of entries) {
			lines.push(
				`  <skill available="${String(entry.available).toLowerCase()}">`,
			);
			lines.push(`    <name>${escapeXml(entry.name)}</name>`);
			lines.push(
				`    <description>${escapeXml(entry.description)}</description>`,
			);
			lines.push(`    <location>${escapeXml(entry.path)}</location>`);
			if (!entry.available && entry.missingRequirements.length > 0) {
				lines.push(
					`    <requires>${escapeXml(entry.missingRequirements.join(", "))}</requires>`,
				);
			}
			lines.push("  </skill>");
		}
		lines.push("</skills>");
		return lines.join("\n");
	}

	private async findSkill(name: string): Promise<{
		name: string;
		path: string;
		source: "workspace" | "builtin";
	} | null> {
		const workspacePath = path.join(this.workspaceSkillsDir, name, "SKILL.md");
		if (await pathExists(workspacePath)) {
			return {
				name,
				path: workspacePath,
				source: "workspace",
			};
		}

		const builtinPath = path.join(this.builtinSkillsDir, name, "SKILL.md");
		if (await pathExists(builtinPath)) {
			return {
				name,
				path: builtinPath,
				source: "builtin",
			};
		}

		return null;
	}

	private async listFromDir(
		root: string,
		source: "workspace" | "builtin",
		skipNames: Set<string> = new Set<string>(),
	): Promise<SkillEntry[]> {
		if (!(await pathExists(root))) {
			return [];
		}

		const children = await fs.readdir(root, { withFileTypes: true });
		const entries: SkillEntry[] = [];
		for (const child of children) {
			if (!child.isDirectory() || skipNames.has(child.name)) {
				continue;
			}

			const skillPath = path.join(root, child.name, "SKILL.md");
			if (!(await pathExists(skillPath))) {
				continue;
			}

			entries.push(
				await this.describeSkill({
					name: child.name,
					path: skillPath,
					source,
				}),
			);
		}

		return entries.sort((left, right) => left.name.localeCompare(right.name));
	}

	private async describeSkill(record: {
		name: string;
		path: string;
		source: "workspace" | "builtin";
	}): Promise<SkillEntry> {
		const raw = await fs.readFile(record.path, "utf8");
		const metadata = parseSkillMetadata(raw);
		const missingRequirements = getMissingRequirements(metadata);

		return {
			...record,
			available: missingRequirements.length === 0,
			description: metadata.description ?? record.name,
			missingRequirements,
		};
	}
}

export function parseSkillMetadata(content: string): SkillMetadata {
	const frontmatter = content.match(FRONTMATTER_PATTERN)?.[1];
	if (!frontmatter) {
		return {};
	}

	const metadata: SkillMetadata = {};
	let section: "bins" | "env" | null = null;
	for (const rawLine of frontmatter.split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (!trimmed) {
			continue;
		}

		if (trimmed.startsWith("description:")) {
			metadata.description = normalizeScalar(
				trimmed.slice("description:".length),
			);
			section = null;
			continue;
		}

		if (trimmed === "requires:") {
			metadata.requires ??= {};
			section = null;
			continue;
		}

		if (trimmed === "bins:") {
			metadata.requires ??= {};
			metadata.requires.bins ??= [];
			section = "bins";
			continue;
		}

		if (trimmed === "env:") {
			metadata.requires ??= {};
			metadata.requires.env ??= [];
			section = "env";
			continue;
		}

		if (trimmed.startsWith("- ") && section) {
			const value = normalizeScalar(trimmed.slice(2));
			if (!value) {
				continue;
			}
			if (section === "bins") {
				metadata.requires?.bins?.push(value);
			} else {
				metadata.requires?.env?.push(value);
			}
			continue;
		}

		section = null;
	}

	return metadata;
}

export function stripFrontmatter(content: string): string {
	const match = content.match(FRONTMATTER_PATTERN);
	if (!match) {
		return content.trim();
	}
	return content.slice(match[0].length).trim();
}

function getMissingRequirements(metadata: SkillMetadata): string[] {
	const missingBins = (metadata.requires?.bins ?? [])
		.filter((binName) => !resolveCommand(binName))
		.map((binName) => `CLI: ${binName}`);
	const missingEnv = (metadata.requires?.env ?? [])
		.filter((envName) => !process.env[envName])
		.map((envName) => `ENV: ${envName}`);
	return [...missingBins, ...missingEnv];
}

function resolveCommand(commandName: string): string | null {
	const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
	const executableNames =
		process.platform === "win32"
			? [
					commandName,
					`${commandName}.exe`,
					`${commandName}.cmd`,
					`${commandName}.bat`,
				]
			: [commandName];

	for (const directory of pathEntries) {
		if (!directory) {
			continue;
		}

		for (const executableName of executableNames) {
			const candidate = path.join(directory, executableName);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}

	return null;
}

function normalizeScalar(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function escapeXml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath);
		return true;
	} catch {
		return false;
	}
}
