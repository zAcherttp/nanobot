import { Command } from "commander";
import path from "node:path";
import { promises as fs } from "node:fs";
import { confirm } from "@inquirer/prompts";
import { initConfigFile } from "../../config/loader.js";

export function onboardCommand() {
  return new Command("onboard")
    .description("Initialize the Miniclaw environment (config and directories)")
    .action(async () => {
      try {
        const cwd = process.cwd();
        const miniclawDir = path.resolve(cwd, ".miniclaw");
        const configPath = path.resolve(miniclawDir, "config.json");

        // Check if config exists
        let shouldCreate = true;
        try {
          await fs.access(configPath);
          // If no error, file exists
          const overwrite = await confirm({
            message: `A config.json already exists at ${configPath}. Do you want to overwrite it?`,
            default: false,
          });

          if (!overwrite) {
            console.log("Onboarding cancelled.");
            shouldCreate = false;
          }
        } catch (error: any) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }

        if (shouldCreate) {
          console.log(`Creating ${miniclawDir} directory...`);
          await fs.mkdir(miniclawDir, { recursive: true });

          console.log("Generating default config.json...");
          const config = await initConfigFile(configPath);

          const workspaceDir = path.resolve(miniclawDir, config.workspace.path);
          const threadsDir = path.resolve(
            miniclawDir,
            config.thread.store.path,
          );

          console.log("Creating required directories...");
          await fs.mkdir(workspaceDir, { recursive: true });
          await fs.mkdir(threadsDir, { recursive: true });

          console.log(`\nSuccessfully onboarded Miniclaw at ${miniclawDir}!`);
          console.log(`- Config: ${configPath}`);
          console.log(`- Workspace: ${workspaceDir}`);
          console.log(`- Threads: ${threadsDir}`);
          console.log(`\nYou can now run: miniclaw gateway`);
        }
      } catch (error) {
        console.error("Failed to onboard:");
        console.error(error);
        process.exit(1);
      }
    });
}
