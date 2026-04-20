import path from "node:path";
import process from "node:process";

export const DEFAULT_DANGEROUS_SHELL_PATTERNS = [
	/\brm\s+-[^\n]*\brf?\b/i,
	/\bdel\s+\/(?:f|q)\b/i,
	/\brmdir\s+\/s\b/i,
	/\bformat\b/i,
	/\bmkfs(?:\.[a-z0-9]+)?\b/i,
	/\bdiskpart\b/i,
	/\bdd\s+if=/i,
	/>+\s*\/dev\/sd[a-z][a-z0-9]*/i,
	/\b(?:shutdown|reboot|poweroff)\b/i,
	/:\(\)\s*\{\s*:\|:\s*&\s*\};\s*:/,
] as const;

const WINDOWS_BASE_ENV_KEYS = [
	"APPDATA",
	"COMSPEC",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"PATH",
	"PATHEXT",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"USERPROFILE",
] as const;

const UNIX_BASE_ENV_KEYS = ["HOME", "LANG", "PATH", "TERM"] as const;

export function findDangerousShellPattern(command: string): string | null {
	for (const pattern of DEFAULT_DANGEROUS_SHELL_PATTERNS) {
		if (pattern.test(command)) {
			return pattern.source;
		}
	}
	return null;
}

export function containsPathTraversal(command: string): boolean {
	return /(?:^|[^\w.])\.\.(?:[\\/]|$)/.test(command);
}

export function extractAbsoluteLikePaths(command: string): string[] {
	const matches = command.match(/(?:[A-Za-z]:[\\/][^\s"'<>|]+|\/[^\s"'<>|]+)/g);
	return matches ? [...new Set(matches)] : [];
}

export function guardWorkspacePathAccess(
	command: string,
	options: {
		cwd: string;
		workspaceRoot: string;
		allowedExtraRoots?: string[];
	},
): string | null {
	if (containsPathTraversal(command)) {
		return "Path traversal outside the workspace is not allowed.";
	}

	const allowedRoots = [
		path.resolve(options.workspaceRoot),
		...(options.allowedExtraRoots ?? []).map((root) => path.resolve(root)),
	];
	for (const candidate of extractAbsoluteLikePaths(command)) {
		const resolved = path.resolve(options.cwd, candidate);
		if (!isWithinAnyRoot(resolved, allowedRoots)) {
			return `Path '${candidate}' escapes the workspace boundary.`;
		}
	}

	return null;
}

export function buildRestrictedSubprocessEnv(
	options: {
		platform?: NodeJS.Platform;
		env?: NodeJS.ProcessEnv;
		allowedEnvKeys?: string[];
	} = {},
): Record<string, string> {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const keys =
		platform === "win32" ? WINDOWS_BASE_ENV_KEYS : UNIX_BASE_ENV_KEYS;
	const result: Record<string, string> = {};

	for (const key of keys) {
		const envKey = resolveEnvKey(env, key);
		if (!envKey) {
			continue;
		}
		const value = env[envKey];
		if (typeof value === "string") {
			result[envKey] = value;
		}
	}

	for (const rawKey of options.allowedEnvKeys ?? []) {
		const envKey = resolveEnvKey(env, rawKey);
		if (!envKey) {
			continue;
		}
		const value = env[envKey];
		if (typeof value === "string") {
			result[envKey] = value;
		}
	}

	return result;
}

function resolveEnvKey(env: NodeJS.ProcessEnv, key: string): string | null {
	if (key in env) {
		return key;
	}
	const lower = key.toLowerCase();
	for (const existingKey of Object.keys(env)) {
		if (existingKey.toLowerCase() === lower) {
			return existingKey;
		}
	}
	return null;
}

function isWithinAnyRoot(targetPath: string, roots: string[]): boolean {
	return roots.some((root) => {
		const relative = path.relative(root, targetPath);
		return (
			relative === "" ||
			(!relative.startsWith("..") && !path.isAbsolute(relative))
		);
	});
}
