import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.resolve(__dirname, "../../templates");
const TEMPLATE_SKILLS_DIR = path.resolve(__dirname, "../../skills");
const TEMPLATE_FILES = [
  "AGENTS.md",
  "GOALS.md",
  "MEMORY.md",
  "SOUL.md",
  "USER.md",
  "TOOLS.md",
  "TASKS.md",
] as const;

export interface WorkspaceBootstrapOptions {
  overwrite?: boolean;
}

export async function copyWorkspaceTemplateFiles(
  workspaceDir: string,
  options: WorkspaceBootstrapOptions = {},
): Promise<void> {
  await fs.mkdir(workspaceDir, { recursive: true });

  for (const filename of TEMPLATE_FILES) {
    const sourcePath = path.join(TEMPLATE_DIR, filename);
    const destinationPath = path.join(workspaceDir, filename);
    await copyFileIfNeeded(sourcePath, destinationPath, options.overwrite);
  }
}

export async function copyWorkspaceSkillDirectories(
  workspaceDir: string,
  options: WorkspaceBootstrapOptions = {},
): Promise<void> {
  const skillsDir = path.join(workspaceDir, "skills");
  await fs.mkdir(skillsDir, { recursive: true });

  const entries = await fs.readdir(TEMPLATE_SKILLS_DIR, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourcePath = path.join(TEMPLATE_SKILLS_DIR, entry.name, "SKILL.md");
    const destinationPath = path.join(skillsDir, entry.name, "SKILL.md");

    if (!(await fileExists(sourcePath))) {
      continue;
    }

    await copyFileIfNeeded(sourcePath, destinationPath, options.overwrite);
  }
}

async function copyFileIfNeeded(
  sourcePath: string,
  destinationPath: string,
  overwrite: boolean = false,
): Promise<void> {
  if (!overwrite && (await fileExists(destinationPath))) {
    return;
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const content = await fs.readFile(sourcePath, "utf8");
  await fs.writeFile(destinationPath, content, "utf8");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
