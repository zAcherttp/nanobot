import { program } from "./cli/index.js";

if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv).catch((error) => {
  console.error(error);
  process.exit(1);
});
