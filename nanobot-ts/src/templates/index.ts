import { promises as fs } from "node:fs";
import path from "node:path";

import { getPackageRoot } from "../config/paths.js";

const TEMPLATES_ROOT = path.join(getPackageRoot(), "templates");

const WORKSPACE_TEMPLATE_MAP = new Map<string, string | null>([
	["AGENTS.md", "workspace/AGENTS.md"],
	["SOUL.md", "workspace/SOUL.md"],
	["USER.md", "workspace/USER.md"],
	["TOOLS.md", "workspace/TOOLS.md"],
	["HEARTBEAT.md", "workspace/HEARTBEAT.md"],
	["memory/MEMORY.md", "workspace/memory/MEMORY.md"],
	["memory/history.jsonl", null],
]);

export async function renderTemplate(
	name: string,
	data: Record<string, string> = {},
): Promise<string> {
	const template = await readBundledTemplate(name);
	return applyTemplateData(template, data);
}

export async function syncWorkspaceTemplates(
	workspacePath: string,
): Promise<string[]> {
	const added: string[] = [];
	await fs.mkdir(workspacePath, { recursive: true });
	await fs.mkdir(path.join(workspacePath, "skills"), { recursive: true });

	for (const [relativePath, templateName] of WORKSPACE_TEMPLATE_MAP) {
		const destination = path.join(workspacePath, relativePath);
		if (await pathExists(destination)) {
			continue;
		}

		await fs.mkdir(path.dirname(destination), { recursive: true });
		const content = templateName ? await readBundledTemplate(templateName) : "";
		await fs.writeFile(destination, content, "utf8");
		added.push(relativePath);
	}

	return added;
}

async function readBundledTemplate(name: string): Promise<string> {
	const resolved = path.join(TEMPLATES_ROOT, ...name.split("/"));
	return fs.readFile(resolved, "utf8");
}

function applyTemplateData(
	template: string,
	data: Record<string, string>,
): string {
	return template.replace(
		/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
		(_match, key: string) => {
			return data[key] ?? "";
		},
	);
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath);
		return true;
	} catch {
		return false;
	}
}
