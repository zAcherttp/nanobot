import chalk from "chalk";
import { MiniclawError } from "../errors/base";

export function handleCliError(error: unknown): never {
  if (error instanceof MiniclawError) {
    // Known domain error, print cleanly
    console.error(chalk.red(`\n❌ [${error.name}] ${error.message}`));
    if (error.cause) {
      console.error(chalk.gray(`   Cause: ${error.cause}`));
    }
  } else if (error instanceof Error) {
    // Unknown or native error, print full stack
    console.error(chalk.red(`\n❌ Unexpected Error: ${error.message}`));
    console.error(chalk.gray(error.stack));
  } else {
    // Completely rogue throw
    console.error(chalk.red("\n❌ An unknown error occurred:"));
    console.error(error);
  }

  process.exit(1);
}
