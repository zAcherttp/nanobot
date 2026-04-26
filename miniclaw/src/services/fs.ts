import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class FileSystemService {
  private readonly isDev: boolean;
  private readonly rootDir: string;

  constructor(appName: string = "miniclaw") {
    const currentFile = fileURLToPath(import.meta.url);
    this.isDev =
      currentFile.endsWith(".ts") || process.env.NODE_ENV === "development";

    const dirName = `.${appName}`;

    if (this.isDev) {
      this.rootDir = path.resolve(process.cwd(), dirName);
    } else {
      this.rootDir = path.join(os.homedir(), dirName);
    }
  }

  public getRootPath(): string {
    return this.rootDir;
  }

  public getConfigPath(): string {
    return path.join(this.rootDir, "config.json");
  }

  public async ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  public resolvePath(...paths: string[]): string {
    return path.resolve(this.rootDir, ...paths);
  }
}
