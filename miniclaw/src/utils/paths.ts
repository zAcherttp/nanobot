import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Get the root directory for the application
 * @param appName - Application name (default: "miniclaw")
 * @returns Root directory path
 */
export function getRootDir(appName: string = "miniclaw"): string {
  const currentFile = fileURLToPath(import.meta.url);
  const isDev =
    currentFile.endsWith(".ts") || process.env.NODE_ENV === "development";
  const dirName = `.${appName}`;

  if (isDev) {
    return path.resolve(process.cwd(), dirName);
  }
  return path.join(os.homedir(), dirName);
}

/**
 * Get the config file path
 * @param appName - Application name (default: "miniclaw")
 * @returns Config file path
 */
export function getConfigPath(appName: string = "miniclaw"): string {
  return path.join(getRootDir(appName), "config.json");
}

/**
 * Resolve a path relative to the root directory
 * @param paths - Path segments to resolve
 * @returns Resolved absolute path
 */
export function resolvePath(...paths: string[]): string {
  return path.resolve(getRootDir(), ...paths);
}
