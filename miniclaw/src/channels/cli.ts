import { input } from "@inquirer/prompts";
import chalk from "chalk";
import type { Channel } from "./base";
import type { MessageBus } from "@/bus/index";
import type { OutboundBusEvent, StreamDelta, EditBusEvent } from "@/bus/types";
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

    // Subscribe to edit events
    this.bus.subscribeEdit(async (event: EditBusEvent) => {
      if (event.channel === this.name) {
        await this.handleEdit(event);
      }
    });

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
          message: {
            role: "user",
            content: text.trim(),
            timestamp: Date.now(),
          },
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

  public async handleOutbound(event: OutboundBusEvent): Promise<void> {
    // If we weren't streaming, we just print the full message
    if (!this.isStreaming) {
      const content =
        typeof event.message.content === "string"
          ? event.message.content
          : event.message.content
              .map((c: any) => (c.type === "text" ? c.text : "[Image]"))
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

  public async handleEdit(event: EditBusEvent): Promise<void> {
    // Clear the current line and reprint with new content
    process.stdout.write("\r\x1b[K");
    process.stdout.write(chalk.green("miniclaw > ") + event.newContent + "\n");
  }
}
