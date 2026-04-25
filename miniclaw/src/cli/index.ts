import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayCommand } from "./commands/gateway.js";
import { onboardCommand } from "./commands/onboard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let pkgVersion = "0.0.0-fallback";
let pkgName = "miniclaw";
let pkgDescription = "Next generation core of nanobot";
try {
  const pkgPath = resolve(__dirname, "../../package.json");
  const pkgData = JSON.parse(readFileSync(pkgPath, "utf-8"));
  if (pkgData.version) {
    pkgVersion = pkgData.version;
  }
  if (pkgData.name) {
    pkgName = pkgData.name;
  }
  if (pkgData.description) {
    pkgDescription = pkgData.description;
  }
} catch (e) {
  // Fallback remains
}

export const program = new Command();

program.name(pkgName).description(pkgDescription).version(pkgVersion);

program.addCommand(gatewayCommand());
program.addCommand(onboardCommand());
