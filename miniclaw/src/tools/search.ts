import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";

const DEFAULT_HEAD_LIMIT = 250;
const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  "dist",
  "build",
  "coverage",
]);
const TYPE_GLOB_MAP: Record<string, string[]> = {
  py: ["*.py", "*.pyi"],
  python: ["*.py", "*.pyi"],
  js: ["*.js", "*.jsx", "*.mjs", "*.cjs"],
  ts: ["*.ts", "*.tsx", "*.mts", "*.cts"],
  tsx: ["*.tsx"],
  jsx: ["*.jsx"],
  json: ["*.json"],
  md: ["*.md", "*.mdx"],
  markdown: ["*.md", "*.mdx"],
  go: ["*.go"],
  rs: ["*.rs"],
  java: ["*.java"],
  sh: ["*.sh", "*.bash"],
  yaml: ["*.yaml", "*.yml"],
  yml: ["*.yaml", "*.yml"],
  toml: ["*.toml"],
  sql: ["*.sql"],
  html: ["*.html", "*.htm"],
  css: ["*.css", "*.scss", "*.sass"],
};

interface SearchToolOptions {
  workspacePath: string;
  restrictToWorkspace: boolean;
}

export function createSearchTools(
  options: SearchToolOptions,
): AgentTool<any, any>[] {
  return [createGlobTool(options), createGrepTool(options)];
}

function createGlobTool(options: SearchToolOptions): AgentTool<any, any> {
  return {
    name: "glob",
    label: "Glob",
    description:
      "Find files matching a glob pattern. Results are sorted by modification time (newest first) and noisy directories are skipped.",
    parameters: Type.Object({
      pattern: Type.String({ minLength: 1 }),
      path: Type.Optional(Type.String()),
      head_limit: Type.Optional(Type.Number({ minimum: 0, maximum: 1000 })),
      offset: Type.Optional(Type.Number({ minimum: 0, maximum: 100000 })),
      entry_type: Type.Optional(
        Type.Union([
          Type.Literal("files"),
          Type.Literal("dirs"),
          Type.Literal("both"),
        ]),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const root = resolveSearchPath(
        params.path || ".",
        options.workspacePath,
        options.restrictToWorkspace,
      );
      if (!root.ok) {
        return textResult(root.error);
      }

      const pattern = normalizePattern(params.pattern);
      const entryType = params.entry_type || "files";
      const limit =
        typeof params.head_limit === "number"
          ? params.head_limit === 0
            ? null
            : params.head_limit
          : DEFAULT_HEAD_LIMIT;
      const offset = params.offset || 0;

      const matches: Array<{ display: string; mtime: number }> = [];
      for await (const entry of walkEntries(root.path, entryType)) {
        const relPath = path
          .relative(root.path, entry.absolute)
          .replace(/\\/g, "/");
        if (!matchesGlob(relPath, entry.name, pattern)) {
          continue;
        }
        matches.push({
          display: entry.isDir ? `${entry.display}/` : entry.display,
          mtime: entry.mtime,
        });
      }

      if (matches.length === 0) {
        return textResult(
          `No paths matched pattern "${params.pattern}" in ${params.path || "."}`,
        );
      }

      matches.sort(
        (left, right) =>
          right.mtime - left.mtime || left.display.localeCompare(right.display),
      );
      const ordered = matches.map((entry) => entry.display);
      const paged = paginate(ordered, limit, offset);
      const text = appendPaginationNote(
        paged.items.join("\n"),
        limit,
        offset,
        paged.truncated,
      );
      return {
        content: [{ type: "text", text }],
        details: {
          matches: paged.items,
        },
      };
    },
  };
}

function createGrepTool(options: SearchToolOptions): AgentTool<any, any> {
  return {
    name: "grep",
    label: "Grep",
    description:
      "Search file contents with a regex or plain-text pattern. Default output is matching file paths only; use content mode for matching lines with context.",
    parameters: Type.Object({
      pattern: Type.String({ minLength: 1 }),
      path: Type.Optional(Type.String()),
      glob: Type.Optional(Type.String()),
      type: Type.Optional(Type.String()),
      case_insensitive: Type.Optional(Type.Boolean()),
      fixed_strings: Type.Optional(Type.Boolean()),
      output_mode: Type.Optional(
        Type.Union([
          Type.Literal("content"),
          Type.Literal("files_with_matches"),
          Type.Literal("count"),
        ]),
      ),
      context_before: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
      context_after: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
      head_limit: Type.Optional(Type.Number({ minimum: 0, maximum: 1000 })),
      offset: Type.Optional(Type.Number({ minimum: 0, maximum: 100000 })),
    }),
    execute: async (_toolCallId, params) => {
      const root = resolveSearchPath(
        params.path || ".",
        options.workspacePath,
        options.restrictToWorkspace,
      );
      if (!root.ok) {
        return textResult(root.error);
      }

      const outputMode = params.output_mode || "files_with_matches";
      const limit =
        typeof params.head_limit === "number"
          ? params.head_limit === 0
            ? null
            : params.head_limit
          : DEFAULT_HEAD_LIMIT;
      const offset = params.offset || 0;
      const flags = params.case_insensitive ? "i" : "";
      let regex: RegExp;
      try {
        regex = new RegExp(
          params.fixed_strings ? escapeRegExp(params.pattern) : params.pattern,
          flags,
        );
      } catch (error) {
        return textResult(
          `Error: invalid regex pattern: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const matches: string[] = [];
      const counts = new Map<string, number>();
      let skippedBinary = 0;
      let skippedLarge = 0;
      let truncatedBySize = false;
      let contentBytes = 0;

      for await (const entry of walkEntries(root.path, "files")) {
        if (
          params.glob &&
          !matchesGlob(entry.relative, entry.name, params.glob)
        ) {
          continue;
        }
        if (!matchesType(entry.name, params.type)) {
          continue;
        }

        const raw = await fs.readFile(entry.absolute);
        if (raw.byteLength > 2_000_000) {
          skippedLarge += 1;
          continue;
        }
        if (isBinary(raw)) {
          skippedBinary += 1;
          continue;
        }

        const content = raw.toString("utf8");
        const lines = content.split(/\r?\n/);
        const matchingLineNumbers: number[] = [];
        for (let index = 0; index < lines.length; index += 1) {
          if (regex.test(lines[index])) {
            matchingLineNumbers.push(index + 1);
          }
        }

        if (matchingLineNumbers.length === 0) {
          continue;
        }

        if (outputMode === "files_with_matches") {
          matches.push(entry.display);
          continue;
        }

        if (outputMode === "count") {
          counts.set(entry.display, matchingLineNumbers.length);
          continue;
        }

        for (const lineNumber of matchingLineNumbers) {
          const block = formatGrepBlock(
            entry.display,
            lines,
            lineNumber,
            params.context_before || 0,
            params.context_after || 0,
          );
          const nextSize =
            contentBytes + block.length + (matches.length > 0 ? 2 : 0);
          if (nextSize > 128_000) {
            truncatedBySize = true;
            break;
          }
          matches.push(block);
          contentBytes = nextSize;
          if (limit !== null && matches.length >= limit + offset) {
            break;
          }
        }

        if (
          truncatedBySize ||
          (limit !== null && matches.length >= limit + offset)
        ) {
          break;
        }
      }

      let text = "";
      if (outputMode === "count") {
        const ordered = [...counts.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([file, count]) => `${file}: ${count}`);
        if (ordered.length === 0) {
          text = `No matches found for pattern "${params.pattern}" in ${params.path || "."}`;
        } else {
          const paged = paginate(ordered, limit, offset);
          text = appendPaginationNote(
            paged.items.join("\n"),
            limit,
            offset,
            paged.truncated,
          );
          text += `\n\n(total matches: ${[...counts.values()].reduce((sum, value) => sum + value, 0)} in ${counts.size} files)`;
        }
      } else {
        const paged = paginate(matches, limit, offset);
        if (paged.items.length === 0) {
          text = `No matches found for pattern "${params.pattern}" in ${params.path || "."}`;
        } else {
          text = paged.items.join(outputMode === "content" ? "\n\n" : "\n");
          text = appendPaginationNote(text, limit, offset, paged.truncated);
        }
      }

      const notes: string[] = [];
      if (truncatedBySize) {
        notes.push("(output truncated due to size)");
      }
      if (skippedBinary > 0) {
        notes.push(`(skipped ${skippedBinary} binary/unreadable files)`);
      }
      if (skippedLarge > 0) {
        notes.push(`(skipped ${skippedLarge} large files)`);
      }
      if (notes.length > 0) {
        text += `\n\n${notes.join("\n")}`;
      }

      return {
        content: [{ type: "text", text }],
        details: {
          outputMode,
        },
      };
    },
  };
}

function textResult(text: string) {
  return {
    content: [{ type: "text", text }],
    details: { text },
  };
}

type ResolvedPath = { ok: true; path: string } | { ok: false; error: string };

function resolveSearchPath(
  inputPath: string,
  workspacePath: string,
  restrictToWorkspace: boolean,
): ResolvedPath {
  const base = path.resolve(workspacePath);
  const resolved = path.resolve(base, inputPath);
  if (
    restrictToWorkspace &&
    resolved !== base &&
    !resolved.startsWith(`${base}${path.sep}`)
  ) {
    return {
      ok: false,
      error: "Error: path is outside the configured workspace",
    };
  }
  return { ok: true, path: resolved };
}

async function* walkEntries(
  rootPath: string,
  entryType: "files" | "dirs" | "both",
): AsyncGenerator<{
  absolute: string;
  display: string;
  relative: string;
  name: string;
  isDir: boolean;
  mtime: number;
}> {
  const rootStat = await fs.stat(rootPath);
  if (rootStat.isFile()) {
    if (entryType !== "dirs") {
      yield {
        absolute: rootPath,
        display: path.basename(rootPath),
        relative: path.basename(rootPath),
        name: path.basename(rootPath),
        isDir: false,
        mtime: rootStat.mtimeMs,
      };
    }
    return;
  }

  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) {
        continue;
      }

      const absolute = path.join(current, entry.name);
      const stat = await fs.stat(absolute);
      const relative = path.relative(rootPath, absolute).replace(/\\/g, "/");
      const display = relative || entry.name;

      if (entry.isDirectory()) {
        if (entryType !== "files") {
          yield {
            absolute,
            display,
            relative,
            name: entry.name,
            isDir: true,
            mtime: stat.mtimeMs,
          };
        }
        stack.push(absolute);
        continue;
      }

      if (entryType !== "dirs") {
        yield {
          absolute,
          display,
          relative,
          name: entry.name,
          isDir: false,
          mtime: stat.mtimeMs,
        };
      }
    }
  }
}

function normalizePattern(pattern: string): string {
  return pattern.trim().replace(/\\/g, "/");
}

function matchesGlob(relPath: string, name: string, pattern: string): boolean {
  const normalizedPattern = normalizePattern(pattern);
  if (!normalizedPattern) {
    return false;
  }

  if (normalizedPattern.includes("/") || normalizedPattern.startsWith("**")) {
    const regex = globToRegExp(normalizedPattern);
    return regex.test(relPath);
  }

  return simpleMatch(name, normalizedPattern);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += ".";
      continue;
    }
    source += escapeRegExp(char);
  }
  source += "$";
  return new RegExp(source);
}

function simpleMatch(value: string, pattern: string): boolean {
  return globToRegExp(pattern).test(value);
}

function paginate<T>(
  items: T[],
  limit: number | null,
  offset: number,
): { items: T[]; truncated: boolean } {
  if (limit === null) {
    return {
      items: items.slice(offset),
      truncated: false,
    };
  }

  return {
    items: items.slice(offset, offset + limit),
    truncated: items.length > offset + limit,
  };
}

function appendPaginationNote(
  text: string,
  limit: number | null,
  offset: number,
  truncated: boolean,
): string {
  if (truncated) {
    if (limit === null) {
      return `${text}\n\n(pagination: offset=${offset})`;
    }
    return `${text}\n\n(pagination: limit=${limit}, offset=${offset})`;
  }

  if (offset > 0) {
    return `${text}\n\n(pagination: offset=${offset})`;
  }

  return text;
}

function matchesType(name: string, type?: string): boolean {
  if (!type) {
    return true;
  }

  const lowered = type.trim().toLowerCase();
  if (!lowered) {
    return true;
  }

  const patterns = TYPE_GLOB_MAP[lowered] || [`*.${lowered}`];
  return patterns.some((pattern) =>
    simpleMatch(name.toLowerCase(), pattern.toLowerCase()),
  );
}

function isBinary(raw: Buffer): boolean {
  if (raw.includes(0)) {
    return true;
  }
  const sample = raw.subarray(0, 4096);
  if (sample.length === 0) {
    return false;
  }
  let nonText = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) {
      nonText += 1;
    }
  }
  return nonText / sample.length > 0.2;
}

function formatGrepBlock(
  displayPath: string,
  lines: string[],
  lineNumber: number,
  contextBefore: number,
  contextAfter: number,
): string {
  const start = Math.max(1, lineNumber - contextBefore);
  const end = Math.min(lines.length, lineNumber + contextAfter);
  const block = [`${displayPath}:${lineNumber}`];
  for (let cursor = start; cursor <= end; cursor += 1) {
    block.push(
      `${cursor === lineNumber ? ">" : " "} ${cursor}| ${lines[cursor - 1]}`,
    );
  }
  return block.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
