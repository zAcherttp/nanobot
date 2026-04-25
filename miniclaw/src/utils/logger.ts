import pino from "pino";
import pretty from "pino-pretty";

const stream = pretty({
  colorize: true,
  ignore: "pid,hostname",
  translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
});

export const logger = pino(stream);
