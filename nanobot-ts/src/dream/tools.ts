import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

export const DREAM_READ_FILE_TOOL = "dream_read_file";
export const DREAM_EDIT_FILE_TOOL = "dream_edit_file";

export function createDreamTools(workspacePath: string): AgentTool[] {
	return [
		{
			name: DREAM_READ_FILE_TOOL,
			label: "Read Memory File",
			description: "Read a text file from the nanobot workspace.",
			parameters: Type.Object({
				path: Type.String(),
			}),
			execute: async (_toolCallId, params) => {
				const input = params as { path: string };
				const filePath = resolveWorkspaceFile(workspacePath, input.path);
				const content = await readFile(filePath, "utf8").catch((error) => {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						return "";
					}
					throw error;
				});
				return {
					content: [
						{
							type: "text",
							text: content,
						},
					],
					details: {
						path: path.relative(workspacePath, filePath),
						bytes: Buffer.byteLength(content, "utf8"),
					},
				};
			},
		},
		{
			name: DREAM_EDIT_FILE_TOOL,
			label: "Edit Memory File",
			description:
				"Replace exact text in a workspace file. If old_text is empty, write the full file content.",
			parameters: Type.Object({
				path: Type.String(),
				old_text: Type.String(),
				new_text: Type.String(),
			}),
			execute: async (_toolCallId, params) => {
				const input = params as {
					path: string;
					old_text: string;
					new_text: string;
				};
				const filePath = resolveWorkspaceFile(workspacePath, input.path);
				const oldText = input.old_text;
				const newText = input.new_text;
				const current = await readFile(filePath, "utf8").catch((error) => {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						return "";
					}
					throw error;
				});
				const next = oldText
					? replaceExactText(current, oldText, newText, filePath)
					: newText;
				await mkdir(path.dirname(filePath), { recursive: true });
				await writeFile(filePath, next, "utf8");
				return {
					content: [
						{
							type: "text",
							text: `Updated ${path.relative(workspacePath, filePath)}`,
						},
					],
					details: {
						path: path.relative(workspacePath, filePath),
						changed: current !== next,
					},
				};
			},
		},
	];
}

function replaceExactText(
	current: string,
	oldText: string,
	newText: string,
	filePath: string,
): string {
	if (!current.includes(oldText)) {
		throw new Error(`Could not find old_text in ${filePath}.`);
	}
	return current.replace(oldText, newText);
}

function resolveWorkspaceFile(workspacePath: string, requestedPath: string): string {
	const workspace = path.resolve(workspacePath);
	const resolved = path.isAbsolute(requestedPath)
		? path.resolve(requestedPath)
		: path.resolve(workspace, requestedPath);
	const normalizedWorkspace = normalizePathForBoundary(workspace);
	const normalizedResolved = normalizePathForBoundary(resolved);
	if (
		normalizedResolved !== normalizedWorkspace &&
		!normalizedResolved.startsWith(`${normalizedWorkspace}${path.sep}`)
	) {
		throw new Error(`Path escapes workspace: ${requestedPath}`);
	}
	return resolved;
}

function normalizePathForBoundary(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
