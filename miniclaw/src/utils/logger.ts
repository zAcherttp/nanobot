import pino from "pino";
import pretty from "pino-pretty";

const stream = pretty({
  colorize: true,
  ignore: "pid,hostname",
  translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
});

export const logger = pino(
  {
    level: process.env.NANOBOT_LOG_LEVEL || "info",
  },
  stream,
);

export function configureLogger(level?: string): void {
  if (!level) {
    return;
  }

  logger.level = level;
}
