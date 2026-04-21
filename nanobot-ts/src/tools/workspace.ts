import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

import {
	toolInvalidRequestMessage,
	toolUnavailableMessage,
} from "./messages.js";

export interface WorkspaceToolsOptions {
	workspacePath: string;
	allowWrites: boolean;
	maxReadChars: number;
	maxSearchResults: number;
}

interface WorkspaceEntry {
	absolutePath: string;
	relativePath: string;
	isDirectory: boolean;
	mtimeMs: number;
}

const DEFAULT_READ_LIMIT = 2_000;
const MAX_FILE_BYTES_FOR_GREP = 2_000_000;
const IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	"__pycache__",
	".venv",
	"venv",
	"dist",
	"build",
	".tox",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".coverage",
	"htmlcov",
]);

const TYPE_EXTENSIONS: Record<string, string[]> = {
	js: [".js", ".jsx", ".mjs", ".cjs"],
	ts: [".ts", ".tsx", ".mts", ".cts"],
	py: [".py"],
	md: [".md", ".mdx", ".markdown"],
	json: [".json", ".jsonc"],
	yaml: [".yaml", ".yml"],
	toml: [".toml"],
	css: [".css"],
	html: [".html", ".htm"],
};

export function createWorkspaceTools(
	options: WorkspaceToolsOptions,
): AgentTool[] {
	const tools: AgentTool[] = [
		createReadFileTool(options),
		createListDirTool(options),
		createGlobTool(options),
		createGrepTool(options),
	];

	if (options.allowWrites) {
		tools.push(createWriteFileTool(options), createEditFileTool(options));
	}

	return tools;
}

function createReadFileTool(options: WorkspaceToolsOptions): AgentTool {
	return {
		name: "read_file",
		label: "Read File",
		description:
			"Read a UTF-8 text file from the workspace. Output is LINE_NUM|CONTENT. Use offset and limit for large files.",
		parameters: Type.Object({
			path: Type.String({
				description: "Workspace-relative file path to read.",
			}),
			offset: Type.Optional(
				Type.Integer({ description: "1-based starting line. Default 1." }),
			),
			limit: Type.Optional(
				Type.Integer({
					description: `Maximum lines to return. Default ${DEFAULT_READ_LIMIT}.`,
				}),
			),
		}),
		execute: async (_toolCallId, params) => {
			const input = params as {
				path?: string;
				offset?: number;
				limit?: number;
			};
			const text = await readWorkspaceFile(input, options);
			return textResult(text, { tool: "read_file", path: input.path ?? "" });
		},
	};
}

function createWriteFileTool(options: WorkspaceToolsOptions): AgentTool {
	return {
		name: "write_file",
		label: "Write File",
		description:
			"Write a UTF-8 text file inside the workspace. Overwrites existing content and creates parent directories.",
		parameters: Type.Object({
			path: Type.String({
				description: "Workspace-relative file path to write.",
			}),
			content: Type.String({ description: "Full file content." }),
		}),
		execute: async (_toolCallId, params) => {
			const input = params as { path?: string; content?: string };
			if (!input.path?.trim()) {
				return textResult(
					toolInvalidRequestMessage("write_file", "path is required."),
					{ tool: "write_file" },
				);
			}
			if (input.content === undefined) {
				return textResult(
					toolInvalidRequestMessage("write_file", "content is required."),
					{
						tool: "write_file",
						path: input.path,
					},
				);
			}

			try {
				const filePath = resolveWorkspacePathStrict(
					options.workspacePath,
					input.path,
				);
				await mkdir(path.dirname(filePath), { recursive: true });
				await writeFile(filePath, input.content, "utf8");
				return textResult(
					`Successfully wrote ${input.content.length} characters to ${relativeDisplayPath(
						options.workspacePath,
						filePath,
					)}`,
					{ tool: "write_file", path: input.path },
				);
			} catch (error) {
				return textResult(
					formatWorkspaceFailure("write_file", input.path, error),
					{
						tool: "write_file",
						path: input.path,
					},
				);
			}
		},
	};
}

function createEditFileTool(options: WorkspaceToolsOptions): AgentTool {
	return {
		name: "edit_file",
		label: "Edit File",
		description:
			"Replace exact text in a UTF-8 workspace file. If old_text is empty, creates a missing/empty file.",
		parameters: Type.Object({
			path: Type.String({
				description: "Workspace-relative file path to edit.",
			}),
			old_text: Type.String({ description: "Exact text to replace." }),
			new_text: Type.String({ description: "Replacement text." }),
			replace_all: Type.Optional(
				Type.Boolean({
					description: "Replace every occurrence. Default false.",
				}),
			),
		}),
		execute: async (_toolCallId, params) => {
			const input = params as {
				path?: string;
				old_text?: string;
				new_text?: string;
				replace_all?: boolean;
			};
			const text = await editWorkspaceFile(input, options);
			return textResult(text, { tool: "edit_file", path: input.path ?? "" });
		},
	};
}

function createListDirTool(options: WorkspaceToolsOptions): AgentTool {
	return {
		name: "list_dir",
		label: "List Directory",
		description:
			"List workspace directory contents. Set recursive=true for nested files. Common noise directories are ignored.",
		parameters: Type.Object({
			path: Type.String({
				description: "Workspace-relative directory path. Use '.' for root.",
			}),
			recursive: Type.Optional(Type.Boolean()),
			max_entries: Type.Optional(Type.Integer()),
		}),
		execute: async (_toolCallId, params) => {
			const input = params as {
				path?: string;
				recursive?: boolean;
				max_entries?: number;
			};
			const text = await listWorkspaceDirectory(input, options);
			return textResult(text, { tool: "list_dir", path: input.path ?? "." });
		},
	};
}

function createGlobTool(options: WorkspaceToolsOptions): AgentTool {
	return {
		name: "glob",
		label: "Glob",
		description:
			"Find workspace files matching a glob pattern. Results are newest first and noise directories are ignored.",
		parameters: Type.Object({
			pattern: Type.String({
				description: "Glob pattern, e.g. '*.ts' or 'tests/**/*.test.ts'.",
			}),
			path: Type.Optional(Type.String()),
			head_limit: Type.Optional(Type.Integer()),
			offset: Type.Optional(Type.Integer()),
			entry_type: Type.Optional(
				Type.String({
					enum: ["files", "dirs", "both"],
					description: "Default files.",
				}),
			),
		}),
		execute: async (_toolCallId, params) => {
			const input = params as {
				pattern?: string;
				path?: string;
				head_limit?: number;
				offset?: number;
				entry_type?: "files" | "dirs" | "both";
			};
			const text = await globWorkspace(input, options);
			return textResult(text, { tool: "glob", pattern: input.pattern ?? "" });
		},
	};
}

function createGrepTool(options: WorkspaceToolsOptions): AgentTool {
	return {
		name: "grep",
		label: "Grep",
		description:
			"Search UTF-8 workspace file contents with a regex or fixed string. Supports file glob/type filtering.",
		parameters: Type.Object({
			pattern: Type.String({
				description: "Regex or fixed text to search for.",
			}),
			path: Type.Optional(Type.String()),
			glob: Type.Optional(Type.String()),
			type: Type.Optional(Type.String()),
			case_insensitive: Type.Optional(Type.Boolean()),
			fixed_strings: Type.Optional(Type.Boolean()),
			output_mode: Type.Optional(
				Type.String({
					enum: ["content", "files_with_matches", "count"],
					description: "Default files_with_matches.",
				}),
			),
			context_before: Type.Optional(Type.Integer()),
			context_after: Type.Optional(Type.Integer()),
			head_limit: Type.Optional(Type.Integer()),
			offset: Type.Optional(Type.Integer()),
		}),
		execute: async (_toolCallId, params) => {
			const input = params as GrepInput;
			const text = await grepWorkspace(input, options);
			return textResult(text, { tool: "grep", pattern: input.pattern ?? "" });
		},
	};
}

async function readWorkspaceFile(
	input: { path?: string; offset?: number; limit?: number },
	options: WorkspaceToolsOptions,
): Promise<string> {
	if (!input.path?.trim()) {
		return toolInvalidRequestMessage("read_file", "path is required.");
	}

	try {
		const filePath = resolveWorkspacePathStrict(
			options.workspacePath,
			input.path,
		);
		const info = await stat(filePath).catch(() => null);
		if (!info) {
			return `Error: File not found: ${input.path}`;
		}
		if (!info.isFile()) {
			return `Error: Not a file: ${input.path}`;
		}

		const raw = await readFile(filePath);
		if (raw.length === 0) {
			return `(Empty file: ${input.path})`;
		}
		if (looksBinary(raw)) {
			return `Error: Cannot read binary file ${input.path}. Only UTF-8 text is supported in this TS slice.`;
		}

		const content = decodeUtf8(raw);
		const lines = content.split(/\r?\n/);
		const offset = Math.max(1, input.offset ?? 1);
		const limit = Math.max(1, input.limit ?? DEFAULT_READ_LIMIT);
		const selected = lines.slice(offset - 1, offset - 1 + limit);
		let output = selected
			.map((line, index) => `${offset + index}|${line}`)
			.join("\n");
		const omitted = lines.length - (offset - 1 + selected.length);
		if (omitted > 0) {
			output += `\n\n(truncated, ${omitted} lines omitted)`;
		}
		return truncateText(output, options.maxReadChars);
	} catch (error) {
		return formatWorkspaceFailure("read_file", input.path, error);
	}
}

async function editWorkspaceFile(
	input: {
		path?: string;
		old_text?: string;
		new_text?: string;
		replace_all?: boolean;
	},
	options: WorkspaceToolsOptions,
): Promise<string> {
	if (!input.path?.trim()) {
		return toolInvalidRequestMessage("edit_file", "path is required.");
	}
	if (input.old_text === undefined) {
		return toolInvalidRequestMessage("edit_file", "old_text is required.");
	}
	if (input.new_text === undefined) {
		return toolInvalidRequestMessage("edit_file", "new_text is required.");
	}

	try {
		const filePath = resolveWorkspacePathStrict(
			options.workspacePath,
			input.path,
		);
		const existing = await readFile(filePath, "utf8").catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") {
					return null;
				}
				throw error;
			},
		);

		if (existing === null) {
			if (input.old_text !== "") {
				return `Error: File not found: ${input.path}`;
			}
			await mkdir(path.dirname(filePath), { recursive: true });
			await writeFile(filePath, input.new_text, "utf8");
			return `Successfully created ${relativeDisplayPath(
				options.workspacePath,
				filePath,
			)}`;
		}

		if (input.old_text === "") {
			if (existing.trim()) {
				return `Error: Cannot create file - ${input.path} already exists and is not empty.`;
			}
			await writeFile(filePath, input.new_text, "utf8");
			return `Successfully edited ${relativeDisplayPath(
				options.workspacePath,
				filePath,
			)}`;
		}

		const occurrences = countOccurrences(existing, input.old_text);
		if (occurrences === 0) {
			return `Error: old_text not found in ${input.path}`;
		}
		if (occurrences > 1 && !input.replace_all) {
			return `Warning: old_text appears ${occurrences} times. Provide more context or set replace_all=true.`;
		}

		const next = input.replace_all
			? existing.split(input.old_text).join(input.new_text)
			: existing.replace(input.old_text, input.new_text);
		await writeFile(filePath, next, "utf8");
		return `Successfully edited ${relativeDisplayPath(
			options.workspacePath,
			filePath,
		)}`;
	} catch (error) {
		return formatWorkspaceFailure("edit_file", input.path, error);
	}
}

async function listWorkspaceDirectory(
	input: { path?: string; recursive?: boolean; max_entries?: number },
	options: WorkspaceToolsOptions,
): Promise<string> {
	const requestedPath = input.path?.trim() || ".";
	try {
		const directoryPath = resolveWorkspacePathStrict(
			options.workspacePath,
			requestedPath,
		);
		const info = await stat(directoryPath).catch(() => null);
		if (!info) {
			return `Error: Directory not found: ${requestedPath}`;
		}
		if (!info.isDirectory()) {
			return `Error: Not a directory: ${requestedPath}`;
		}

		const maxEntries = Math.max(1, input.max_entries ?? 200);
		const entries = input.recursive
			? await walkWorkspace(directoryPath, directoryPath)
			: await readDirectoryEntries(directoryPath, directoryPath);
		const displayed = entries.slice(0, maxEntries).map((entry) => {
			if (input.recursive) {
				return entry.isDirectory
					? `${entry.relativePath}/`
					: entry.relativePath;
			}
			const name = path.basename(entry.relativePath);
			return `${entry.isDirectory ? "[dir]" : "[file]"} ${name}`;
		});

		if (displayed.length === 0) {
			return `Directory ${requestedPath} is empty`;
		}
		let output = displayed.join("\n");
		if (entries.length > maxEntries) {
			output += `\n\n(truncated, showing first ${maxEntries} of ${entries.length} entries)`;
		}
		return output;
	} catch (error) {
		return formatWorkspaceFailure("list_dir", requestedPath, error);
	}
}

async function globWorkspace(
	input: {
		pattern?: string;
		path?: string;
		head_limit?: number;
		offset?: number;
		entry_type?: "files" | "dirs" | "both";
	},
	options: WorkspaceToolsOptions,
): Promise<string> {
	if (!input.pattern?.trim()) {
		return toolInvalidRequestMessage("glob", "pattern is required.");
	}

	try {
		const root = resolveWorkspacePathStrict(
			options.workspacePath,
			input.path?.trim() || ".",
		);
		const info = await stat(root).catch(() => null);
		if (!info) {
			return `Error: Path not found: ${input.path ?? "."}`;
		}
		if (!info.isDirectory()) {
			return `Error: Not a directory: ${input.path ?? "."}`;
		}

		const regex = globToRegExp(input.pattern);
		const entryType = input.entry_type ?? "files";
		const includeFiles = entryType === "files" || entryType === "both";
		const includeDirs = entryType === "dirs" || entryType === "both";
		const matches = (await walkWorkspace(root, root))
			.filter((entry) => {
				if (entry.isDirectory && !includeDirs) {
					return false;
				}
				if (!entry.isDirectory && !includeFiles) {
					return false;
				}
				return regex.test(toPosixPath(entry.relativePath));
			})
			.sort((a, b) => b.mtimeMs - a.mtimeMs);
		const offset = Math.max(0, input.offset ?? 0);
		const limit =
			input.head_limit === 0
				? matches.length
				: Math.max(1, input.head_limit ?? options.maxSearchResults);
		const selected = matches.slice(offset, offset + limit);

		if (selected.length === 0) {
			return "No matches.";
		}
		let output = selected
			.map((entry) =>
				entry.isDirectory ? `${entry.relativePath}/` : entry.relativePath,
			)
			.join("\n");
		if (matches.length > offset + selected.length) {
			output += `\n\n(truncated, showing ${selected.length} of ${matches.length} matches)`;
		}
		return output;
	} catch (error) {
		return formatWorkspaceFailure("glob", input.path ?? ".", error);
	}
}

interface GrepInput {
	pattern?: string;
	path?: string;
	glob?: string;
	type?: string;
	case_insensitive?: boolean;
	fixed_strings?: boolean;
	output_mode?: "content" | "files_with_matches" | "count";
	context_before?: number;
	context_after?: number;
	head_limit?: number;
	offset?: number;
}

async function grepWorkspace(
	input: GrepInput,
	options: WorkspaceToolsOptions,
): Promise<string> {
	if (!input.pattern?.trim()) {
		return toolInvalidRequestMessage("grep", "pattern is required.");
	}

	try {
		const target = resolveWorkspacePathStrict(
			options.workspacePath,
			input.path?.trim() || ".",
		);
		const info = await stat(target).catch(() => null);
		if (!info) {
			return `Error: Path not found: ${input.path ?? "."}`;
		}
		const files = info.isDirectory()
			? (await walkWorkspace(target, target)).filter(
					(entry) => !entry.isDirectory,
				)
			: [
					{
						absolutePath: target,
						relativePath: relativeDisplayPath(options.workspacePath, target),
						isDirectory: false,
						mtimeMs: info.mtimeMs,
					},
				];
		const filteredFiles = filterGrepFiles(files, input);
		const regex = new RegExp(
			input.fixed_strings ? escapeRegExp(input.pattern) : input.pattern,
			input.case_insensitive ? "i" : "",
		);
		const mode = input.output_mode ?? "files_with_matches";
		const results: string[] = [];

		for (const file of filteredFiles) {
			const fileInfo = await stat(file.absolutePath).catch(() => null);
			if (!fileInfo || fileInfo.size > MAX_FILE_BYTES_FOR_GREP) {
				continue;
			}
			const raw = await readFile(file.absolutePath);
			if (looksBinary(raw)) {
				continue;
			}
			const text = decodeUtf8(raw);
			const lines = text.split(/\r?\n/);
			const matchingLines = lines
				.map((line, index) => ({ line, lineNumber: index + 1 }))
				.filter(({ line }) => regex.test(line));
			if (matchingLines.length === 0) {
				continue;
			}
			if (mode === "files_with_matches") {
				results.push(file.relativePath);
			} else if (mode === "count") {
				results.push(`${file.relativePath}: ${matchingLines.length}`);
			} else {
				for (const match of matchingLines) {
					results.push(
						formatGrepBlock(
							file.relativePath,
							lines,
							match.lineNumber,
							Math.max(0, input.context_before ?? 0),
							Math.max(0, input.context_after ?? 0),
						),
					);
				}
			}
		}

		const offset = Math.max(0, input.offset ?? 0);
		const limit =
			input.head_limit === 0
				? results.length
				: Math.max(1, input.head_limit ?? options.maxSearchResults);
		const selected = results.slice(offset, offset + limit);
		if (selected.length === 0) {
			return "No matches.";
		}
		let output = selected.join(mode === "content" ? "\n\n" : "\n");
		if (results.length > offset + selected.length) {
			output += `\n\n(truncated, showing ${selected.length} of ${results.length} results)`;
		}
		return truncateText(output, options.maxReadChars);
	} catch (error) {
		return formatWorkspaceFailure("grep", input.path ?? ".", error);
	}
}

function filterGrepFiles(
	files: WorkspaceEntry[],
	input: GrepInput,
): WorkspaceEntry[] {
	const globRegex = input.glob ? globToRegExp(input.glob) : null;
	const extensions = input.type ? TYPE_EXTENSIONS[input.type] : null;
	return files.filter((entry) => {
		if (globRegex && !globRegex.test(toPosixPath(entry.relativePath))) {
			return false;
		}
		if (extensions && !extensions.includes(path.extname(entry.relativePath))) {
			return false;
		}
		return true;
	});
}

function formatGrepBlock(
	displayPath: string,
	lines: string[],
	matchLine: number,
	before: number,
	after: number,
): string {
	const start = Math.max(1, matchLine - before);
	const end = Math.min(lines.length, matchLine + after);
	const block = [`${displayPath}:${matchLine}`];
	for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
		const marker = lineNumber === matchLine ? ">" : " ";
		block.push(`${marker} ${lineNumber}| ${lines[lineNumber - 1] ?? ""}`);
	}
	return block.join("\n");
}

async function readDirectoryEntries(
	root: string,
	base: string,
): Promise<WorkspaceEntry[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const result: WorkspaceEntry[] = [];
	for (const entry of entries) {
		if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) {
			continue;
		}
		const absolutePath = path.join(root, entry.name);
		const info = await stat(absolutePath);
		result.push({
			absolutePath,
			relativePath: relativeDisplayPath(base, absolutePath),
			isDirectory: entry.isDirectory(),
			mtimeMs: info.mtimeMs,
		});
	}
	return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function walkWorkspace(
	root: string,
	base: string,
): Promise<WorkspaceEntry[]> {
	const direct = await readDirectoryEntries(root, base);
	const result: WorkspaceEntry[] = [];
	for (const entry of direct) {
		result.push(entry);
		if (entry.isDirectory) {
			result.push(...(await walkWorkspace(entry.absolutePath, base)));
		}
	}
	return result;
}

export function resolveWorkspacePathStrict(
	workspacePath: string,
	requestedPath: string,
): string {
	const workspace = path.resolve(workspacePath);
	const resolved = path.isAbsolute(requestedPath)
		? path.resolve(requestedPath)
		: path.resolve(workspace, requestedPath);
	if (!isWithinRoot(resolved, workspace)) {
		throw new Error(`Path escapes workspace: ${requestedPath}`);
	}
	return resolved;
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
	const normalizedTarget = normalizePathForBoundary(targetPath);
	const normalizedRoot = normalizePathForBoundary(rootPath);
	const relative = path.relative(normalizedRoot, normalizedTarget);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

function normalizePathForBoundary(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function relativeDisplayPath(base: string, target: string): string {
	const relative = path.relative(path.resolve(base), path.resolve(target));
	return toPosixPath(relative || ".");
}

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

function globToRegExp(pattern: string): RegExp {
	const normalized = toPosixPath(pattern.trim());
	let source = "^";
	for (let index = 0; index < normalized.length; index += 1) {
		const char = normalized[index];
		const next = normalized[index + 1];
		if (char === "*") {
			if (next === "*") {
				source += ".*";
				index += 1;
			} else {
				source += "[^/]*";
			}
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		source += escapeRegExp(char ?? "");
	}
	source += "$";
	return new RegExp(source);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksBinary(buffer: Buffer): boolean {
	return buffer.includes(0);
}

function decodeUtf8(buffer: Buffer): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, Math.max(0, maxChars - 32))}\n\n(truncated)`;
}

function countOccurrences(text: string, needle: string): number {
	if (!needle) {
		return 0;
	}
	let count = 0;
	let index = 0;
	while (true) {
		const matchIndex = text.indexOf(needle, index);
		if (matchIndex === -1) {
			break;
		}
		count += 1;
		index = matchIndex + needle.length;
	}
	return count;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatWorkspaceFailure(
	tool: string,
	target: string | undefined,
	error: unknown,
): string {
	const reason = errorMessage(error);
	if (reason.includes("Path escapes workspace")) {
		return toolInvalidRequestMessage(
			tool,
			reason,
			"Use a workspace-relative path inside the configured workspace.",
		);
	}
	return toolUnavailableMessage({
		tool,
		target,
		reason,
		guidance:
			"Do not treat this as evidence that the requested workspace data does not exist. Check the path or retry after the filesystem issue is resolved.",
	});
}

function textResult(text: string, details: Record<string, unknown>) {
	return {
		content: [
			{
				type: "text" as const,
				text,
			},
		],
		details,
	};
}
