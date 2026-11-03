// SPDX-License-Identifier: AGPL-3.0-or-later
// The CLI logger: pino underneath (structured JSON lines, level filtering,
// child bindings), wrapped so the config's `redact` substring list masks any
// occurrence anywhere in a line BEFORE it reaches the sink. The sink is
// stderr by default — stdout belongs to command output (assistant text,
// tables), never to logs.

import { Writable } from "node:stream";
import pino from "pino";
import type { Logger } from "@nyx/protocol";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structural mirror of @nyx/config's logging section. */
export interface LoggingConfig {
  level: LogLevel;
  redact: string[];
}

export interface CliLoggerOptions {
  /**
   * Line sink (receives full JSON lines, newline-terminated). Defaults to
   * process.stderr. Tests inject a capturing writable here.
   */
  sink?: { write(line: string): void };
}

const LEVELS: ReadonlyArray<LogLevel> = ["debug", "info", "warn", "error"];

/**
 * Create the protocol Logger over a pino instance. Redaction is enforced in
 * the destination stream (not in pino's path-based redact, which cannot do
 * substring masking): every configured `redact` substring becomes `***`
 * anywhere it appears in the serialized line — keys or values.
 */
export function createCliLogger(
  logging: LoggingConfig,
  options: CliLoggerOptions = {},
): Logger {
  const sink = options.sink ?? process.stderr;
  const needles = logging.redact.filter((needle) => needle.length > 0);

  const destination = new Writable({
    write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
      try {
        let line = chunk.toString("utf8");
        for (const needle of needles) {
          if (line.includes(needle)) line = line.split(needle).join("***");
        }
        sink.write(line);
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });

  const level = LEVELS.includes(logging.level) ? logging.level : "info";
  const pinoLogger = pino(
    {
      level,
      // Human-readable level labels (pino's default is numeric).
      formatters: { level: (label: string) => ({ level: label }) },
    },
    destination,
  );

  const adapt = (inner: pino.Logger): Logger => ({
    debug: (msg, ctx) => inner.debug(ctx ?? {}, msg),
    info: (msg, ctx) => inner.info(ctx ?? {}, msg),
    warn: (msg, ctx) => inner.warn(ctx ?? {}, msg),
    error: (msg, ctx) => inner.error(ctx ?? {}, msg),
    child: (bindings) => adapt(inner.child(bindings)),
  });

  return adapt(pinoLogger);
}
