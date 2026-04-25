import { program } from "./cli/index";
import { handleCliError } from "./cli/errors";

if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv).catch(handleCliError);
