import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_DATA_DIR_NAME = ".nanobot";
export const DEFAULT_CONFIG_FILENAME = "config.json";
export const DEFAULT_WORKSPACE_PATH = "workspace";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(MODULE_DIR, "..", "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..");

export type RuntimeMode = "development" | "production";

export function detectRuntimeMode(): RuntimeMode {
	const override = process.env.NANOBOT_TS_ENV?.toLowerCase();
	if (override === "development" || override === "dev") {
		return "development";
	}
	if (override === "production" || override === "prod") {
		return "production";
	}
	if (process.env.NODE_ENV === "production") {
		return "production";
	}
	if (isSourceCheckout()) {
		return "development";
	}
	return "production";
}

export function getDefaultDataDir(): string {
	if (detectRuntimeMode() === "development") {
		return path.resolve(process.cwd(), DEFAULT_DATA_DIR_NAME);
	}
	return path.join(os.homedir(), DEFAULT_DATA_DIR_NAME);
}

export function resolveConfigPath(cliPath?: string): string {
	const configured = cliPath ?? process.env.NANOBOT_TS_CONFIG;
	if (configured) {
		return resolveFromBase(configured);
	}
	return path.join(getDefaultDataDir(), DEFAULT_CONFIG_FILENAME);
}

export function resolveWorkspacePath(
	workspacePath?: string,
	baseDir?: string,
): string {
	const configured = workspacePath ?? process.env.NANOBOT_TS_WORKSPACE;
	if (configured) {
		return resolveFromBase(configured, baseDir);
	}
	return path.join(getDefaultDataDir(), DEFAULT_WORKSPACE_PATH);
}

function isSourceCheckout(): boolean {
	return (
		existsSync(path.join(PACKAGE_ROOT, "package.json")) &&
		existsSync(path.join(PACKAGE_ROOT, "src")) &&
		(existsSync(path.join(PACKAGE_ROOT, "tsconfig.json")) ||
			existsSync(path.join(REPO_ROOT, ".git")))
	);
}

function resolveFromBase(targetPath: string, baseDir = process.cwd()): string {
	if (path.isAbsolute(targetPath)) {
		return targetPath;
	}
	return path.resolve(baseDir, targetPath);
}
