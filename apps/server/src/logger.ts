// SPDX-License-Identifier: AGPL-3.0-or-later
// Small structured logger implementing @nyx/protocol's Logger contract:
// JSON-lines to stdout, level filtering, child bindings, and REDACTION —
// every configured `redact` substring is masked as *** anywhere it appears in
// the serialized line (keys or values), so secrets never reach a sink. There
// is deliberately no pino dependency here: the surface is tiny and the
// redaction guarantee is too important to leave to configuration.

import type { Logger } from "@nyx/protocol";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structural mirror of @nyx/config's logging section. */
export interface LoggingConfig {
  level: LogLevel;
  redact: string[];
}

export interface LoggerOptions {
  /**
   * Line sink (receives one full JSON line including the trailing newline).
   * Defaults to process.stdout. Tests inject a capturing writable here.
   */
  sink?: { write(line: string): void };
  /** Clock for the `time` field; defaults to Date.now. */
  now?: () => number;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Create the protocol Logger. One JSON object per line:
 * `{level, time, msg, ...bindings, ...ctx}` with every `redact` substring
 * masked as `***` before the line is handed to the sink.
 */
export function createLogger(logging: LoggingConfig, options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_WEIGHT[logging.level] ?? LEVEL_WEIGHT.info;
  const sink = options.sink ?? process.stdout;
  const now = options.now ?? Date.now;
  const needles = logging.redact.filter((needle) => needle.length > 0);

  const write = (
    level: LogLevel,
    msg: string,
    ctx: Record<string, unknown> | undefined,
    bindings: Record<string, unknown>,
  ): void => {
    if (LEVEL_WEIGHT[level] < threshold) return;
    const record: Record<string, unknown> = {
      level,
      time: now(),
      msg,
      ...bindings,
      ...(ctx ?? {}),
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      // Unserializable context (bigint, cycles): log a safe line rather
      // than throwing from inside a logging call.
      line = JSON.stringify({ level, time: now(), msg, note: "unserializable log context" });
    }
    for (const needle of needles) {
      if (line.includes(needle)) line = line.split(needle).join("***");
    }
    sink.write(`${line}\n`);
  };

  const make = (bindings: Record<string, unknown>): Logger => ({
    debug: (msg, ctx) => write("debug", msg, ctx, bindings),
    info: (msg, ctx) => write("info", msg, ctx, bindings),
    warn: (msg, ctx) => write("warn", msg, ctx, bindings),
    error: (msg, ctx) => write("error", msg, ctx, bindings),
    child: (childBindings) => make({ ...bindings, ...childBindings }),
  });

  return make({});
}
