import { Command } from "commander";
import chalk from "chalk";
import { gatewayCommand } from "./commands/gateway";
import { onboardCommand } from "./commands/onboard";
import { pkgName, pkgDescription, pkgVersion } from "@/utils/pkg";

export const program = new Command();

program.configureOutput({
  writeErr: (str) => {
    console.error(chalk.red(str.trim()));
    console.info(chalk.yellow("Use --help for usage instructions!"));
  },
});

program.name(pkgName).description(pkgDescription).version(pkgVersion);

program.addCommand(gatewayCommand());
program.addCommand(onboardCommand());
