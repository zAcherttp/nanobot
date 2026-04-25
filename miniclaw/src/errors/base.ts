import { ZodIssue } from "zod";

export class MiniclawError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ConfigLoadError extends MiniclawError {
  constructor(
    public readonly path: string,
    public readonly cause: unknown,
  ) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to load config at ${path}: ${causeMsg}`, { cause });
  }
}

export class ConfigValidationError extends MiniclawError {
  constructor(
    public readonly issues: ZodIssue[],
    public readonly path?: string,
  ) {
    const summary = issues
      .map((issue, i) => `${i + 1}. ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    super(`Configuration validation failed:\n${summary}`);
  }
}

// ─── Thread Errors ────────────────────────────────────

export class ThreadNotFoundError extends MiniclawError {
  constructor(threadId: string) {
    super(`Thread not found: ${threadId}`);
  }
}

export class ThreadCorruptedError extends MiniclawError {
  constructor(
    threadId: string,
    details?: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Thread data corrupted: ${threadId}${details ? ` - ${details}` : ""}`,
      options,
    );
  }
}

export class ThreadWriteError extends MiniclawError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
