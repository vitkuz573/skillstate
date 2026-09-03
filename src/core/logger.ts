/**
 * @non-paper JSON-line logger with secret scrubbing.
 *
 * The paper logs nothing. This module adds an OPTIONAL, additive logging
 * seam: the runtime calls it ONLY when a caller passes `logger?` (unset =
 * silent, paper-exact). Every line is a single JSON object
 * `{ level, msg, ts, ...fields }` passed through `redactSecrets`, so
 * credential-shaped spans (tokens, keys, PEM blocks) can never leak via
 * logs even when prompts/observations carry them.
 *
 * Zero dependencies, Node >= 20, ESM.
 */
import { redactSecrets } from './redaction.js';

/** @non-paper log severity. */
export type LogLevel = 'info' | 'warn' | 'error';

/** @non-paper structured fields attached to a log line. */
export interface LogFields {
  [key: string]: unknown;
}

/** @non-paper minimal structured logger consumed by the runtime. */
export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** @non-paper options for {@link JsonLogger}. All optional. */
export interface JsonLoggerOptions {
  /** Line sink (default: `console.log`). One JSON object per call. */
  sink?: (line: string) => void;
  /** Millis source for `ts` (default: `Date.now`). */
  now?: () => number;
}

/**
 * @non-paper JSON-line `Logger`. The ENTRY is built first, then the whole
 * serialized line is scrubbed — secrets hiding inside `fields` are caught
 * exactly like secrets in the message.
 */
export class JsonLogger implements Logger {
  private readonly sink: (line: string) => void;
  private readonly now: () => number;

  constructor(options?: JsonLoggerOptions) {
    this.sink = options?.sink ?? ((line: string): void => console.log(line));
    this.now = options?.now ?? ((): number => Date.now());
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    const entry = { level, msg: message, ts: this.now(), ...(fields ?? {}) };
    this.sink(redactSecrets(JSON.stringify(entry)));
  }
}
