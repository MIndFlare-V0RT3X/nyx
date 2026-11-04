// SPDX-License-Identifier: AGPL-3.0-or-later
// `nyx run` — the non-interactive one-shot: create (or reuse) a session, run
// exactly one turn, stream the assistant text to stdout, exit 0/1. Tool calls
// render one transcript line each on stderr; stdout carries ONLY the
// assistant text so `nyx run "..."` is pipe-safe. Any pending approval is
// auto-denied after a short grace period (deny-first, never block a script).

import { nanoid } from "nanoid";
import type { Engagement, SessionEvent } from "@nyx/protocol";
import { createLocalRuntime, type LocalRuntime } from "./local.js";
import { describeToolOutput, formatUsage, truncate, compactJson } from "./format.js";
import { CliError } from "./errors.js";
import type { NyxConfig } from "@nyx/config";
import type { ModelProvider } from "@nyx/protocol";

/** Minimal writable surface — process.stdout/stderr and test doubles match. */
export interface LineWriter {
  write(chunk: string): void;
}

export class StringLineWriter implements LineWriter {
  private buf = "";
  write(chunk: string): void {
    this.buf += chunk;
  }
  /** Everything written so far. */
  toString(): string {
    return this.buf;
  }
}

export interface RunOneShotOptions {
  config: NyxConfig;
  data_dir: string;
  message: string;
  /** Reuse an existing session; otherwise a fresh one is created. */
  session_id?: string;
  persona_id?: string;
  /** Bound at session creation; rejected when combined with session_id. */
  engagement?: Engagement | null;
  /** Test injection: replaces config-derived providers. */
  providers?: ModelProvider[];
  /** Auto-deny grace period in ms (default 2000). */
  auto_deny_ms?: number;
  /** Assistant text stream (default process.stdout). */
  stdout?: LineWriter;
  /** Transcript + diagnostics (default process.stderr). */
  stderr?: LineWriter;
}

export interface RunOneShotResult {
  /** 0 when the turn completed, 1 when it failed or could not start. */
  exit_code: 0 | 1;
  session_id: string;
  turn_id: string;
  /** Concatenated text deltas — exactly what was streamed to stdout. */
  assistant_text: string;
  /** The final usage of the turn (null when the turn failed). */
  usage: string | null;
}

/** Render one loop event as transcript/diagnostic lines on stderr. */
function renderEvent(
  event: SessionEvent,
  callNames: Map<string, string>,
  stderr: LineWriter,
): string {
  switch (event.type) {
    case "text.delta":
      return event.text;
    case "tool.call":
      callNames.set(event.call_id, event.name);
      stderr.write(`→ ${event.name} ${truncate(compactJson(event.input), 120)}\n`);
      return "";
    case "tool.result":
      stderr.write(
        `✓ ${callNames.get(event.call_id) ?? event.call_id} ${describeToolOutput(event.output)}\n`,
      );
      return "";
    case "tool.error":
      stderr.write(`✗ ${callNames.get(event.call_id) ?? event.call_id}: ${event.error.message}\n`);
      return "";
    case "action.denied":
      stderr.write(
        `✗ ${callNames.get(event.call_id) ?? event.call_id}: denied (${event.reason}) ${truncate(event.detail, 100)}\n`,
      );
      return "";
    default:
      return "";
  }
}

/**
 * Run one non-interactive turn. Renders as the events arrive: text deltas to
 * `stdout`, tool transcript to `stderr`. Never resolves while an approval is
 * pending longer than `auto_deny_ms`.
 */
export async function runOneShot(opts: RunOneShotOptions): Promise<RunOneShotResult> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  if (opts.engagement !== undefined && opts.engagement !== null && opts.session_id !== undefined) {
    throw new CliError(
      "validation_failed",
      "--engagement cannot be combined with --session: an engagement is bound at session creation and immutable",
    );
  }

  const runtime: LocalRuntime = createLocalRuntime({
    config: opts.config,
    data_dir: opts.data_dir,
    ...(opts.providers !== undefined ? { providers: opts.providers } : {}),
    approval_mode: "auto-deny",
    ...(opts.auto_deny_ms !== undefined ? { auto_deny_ms: opts.auto_deny_ms } : {}),
    on_approval_event: (event) => {
      if (event.type === "approval.requested") {
        stderr.write(`⏸ approval required: ${truncate(event.summary, 120)} — auto-denying\n`);
      }
    },
    on_note: (line) => stderr.write(`${line}\n`),
  });

  try {
    let session_id: string;
    if (opts.session_id !== undefined) {
      const meta = await runtime.meta(opts.session_id);
      if (meta === null) {
        throw new CliError("not_found", `session ${opts.session_id} not found`);
      }
      session_id = meta.session_id;
    } else {
      const title = truncate(opts.message.split("\n")[0] ?? "nyx run", 60);
      const meta = await runtime.createSession({
        ...(opts.persona_id !== undefined ? { persona_id: opts.persona_id } : {}),
        title,
        ...(opts.engagement !== undefined ? { engagement: opts.engagement } : {}),
      });
      session_id = meta.session_id;
    }
    stderr.write(`session ${session_id}\n`);
    const turn_id = nanoid(12);
    let assistantText = "";
    let usageLine: string | null = null;
    const callNames = new Map<string, string>();

    const result = await runtime.runTurn(
      { session_id, turn_id, content: [{ type: "text", text: opts.message }] },
      (event) => {
        const delta = renderEvent(event, callNames, stderr);
        if (delta !== "") {
          assistantText += delta;
          stdout.write(delta);
        }
        if (event.type === "turn.completed") {
          usageLine = formatUsage(event.usage);
        }
      },
    );

    if (assistantText.length > 0) stdout.write("\n");

    if (result.error !== null) {
      stderr.write(`✗ turn failed: ${result.error.message}\n`);
      return { exit_code: 1, session_id, turn_id, assistant_text: assistantText, usage: null };
    }
    if (result.failed) {
      const failed = result.events.find((e) => e.type === "turn.failed");
      const message =
        failed !== undefined && failed.type === "turn.failed"
          ? failed.error.message
          : "unknown error";
      stderr.write(`✗ turn failed: ${message}\n`);
      return { exit_code: 1, session_id, turn_id, assistant_text: assistantText, usage: null };
    }
    if (!result.completed) {
      stderr.write("✗ turn did not complete\n");
      return { exit_code: 1, session_id, turn_id, assistant_text: assistantText, usage: null };
    }
    if (usageLine !== null) stderr.write(`usage ${usageLine}\n`);
    return { exit_code: 0, session_id, turn_id, assistant_text: assistantText, usage: usageLine };
  } catch (err) {
    // Surface-level failures (unknown session, unknown persona, bad flags):
    // a one-shot run reports them on stderr and exits 1 — it never crashes.
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`✗ ${message}\n`);
    return {
      exit_code: 1,
      session_id: opts.session_id ?? "",
      turn_id: "",
      assistant_text: "",
      usage: null,
    };
  } finally {
    await runtime.close();
  }
}
