import { input } from "@inquirer/prompts";
import chalk from "chalk";
import type { Channel } from "./base";
import type { MessageBus } from "@/bus/index";
import type { ThreadMessage, StreamDelta } from "@/bus/types";
import { logger } from "@/utils/logger";
import { ulid } from "ulid";

export class CliChannel implements Channel {
  public readonly name = "cli";
  private isStreaming = false;
  private isActive = false;
  private resolveTurn: (() => void) | null = null;

  constructor(private readonly bus: MessageBus) {}

  public async start(): Promise<void> {
    this.isActive = true;

    // Run the prompt loop in the background
    // We use setImmediate so it doesn't block the start() completion
    setImmediate(() => {
      this.promptLoop().catch((err) => {
        logger.error({ err }, "CLI loop crashed");
      });
    });
  }

  private async promptLoop() {
    while (this.isActive) {
      try {
        const text = await input({ message: ">" }); // Inquirer adds a space automatically

        if (!text.trim()) {
          continue;
        }

        if (
          text.toLowerCase() === "/exit" ||
          text.toLowerCase() === "/quit" ||
          text.toLowerCase() === "/bye"
        ) {
          this.isActive = false;
          process.exit(0);
        }

        // We send it to the bus
        this.bus.publishInbound({
          id: ulid(),
          role: "user",
          content: text.trim(),
          timestamp: new Date().toISOString(),
          channel: this.name,
        });

        // Wait for the agent to reply
        await new Promise<void>((resolve) => {
          this.resolveTurn = resolve;
        });
      } catch (err: any) {
        if (err.name === "ExitPromptError") {
          this.isActive = false;
          process.exit(0);
        } else {
          logger.error({ err }, "Prompt error");
          break;
        }
      }
    }
  }

  public async stop(): Promise<void> {
    this.isActive = false;
    if (this.resolveTurn) {
      this.resolveTurn();
      this.resolveTurn = null;
    }
  }

  public async handleOutbound(message: ThreadMessage): Promise<void> {
    // If we weren't streaming, we just print the full message
    if (!this.isStreaming) {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((c) => (c.type === "text" ? c.text : "[Image]"))
              .join("\n");

      process.stdout.write(chalk.green("miniclaw > ") + content + "\n");
    } else {
      // If we were streaming, the last token was printed, just print a newline
      process.stdout.write("\n");
      this.isStreaming = false;
    }

    // Unlock the loop so Inquirer can prompt again
    if (this.resolveTurn) {
      this.resolveTurn();
      this.resolveTurn = null;
    }
  }

  public async handleStreamDelta(delta: StreamDelta): Promise<void> {
    if (!this.isStreaming) {
      this.isStreaming = true;
      process.stdout.write(chalk.green("miniclaw > "));
    }
    process.stdout.write(delta.delta);
  }
}
