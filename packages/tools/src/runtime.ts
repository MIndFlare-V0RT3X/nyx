// SPDX-License-Identifier: AGPL-3.0-or-later
// The tool runtime — the single enforcement point every ToolCall passes
// through before any handler runs. The pipeline order IS the security
// architecture (each numbered step maps to README §"Enforcement pipeline"):
//
//   0. timeout controller linked to ctx.signal (def.timeout_ms ?? default)
//   1. emit tool.call (audit: what the model asked for, verbatim)
//   2. route — unknown tool → tool.error(tool_unknown) + model-facing text
//   3. validate input with the tool's zod schema
//   4. path containment — resolve declared path fields against workdir,
//      rewrite the input, reject escapes BEFORE any handler runs
//   5. scope — net.egress tools resolve their target against the session's
//      immutable engagement (no engagement, bad url, or out-of-scope → deny)
//   6. policy evaluate → deny stops; ask (or force_ask) awaits the approval
//      engine (the SURFACE emits approval.* events, never this runtime)
//   7. execute the handler with the timeout-linked signal
//   8. spill outputs larger than max_output_bytes into an artifact file
//   9. handler failure / timeout → tool.error(tool_failed|tool_timeout|aborted)
//  10. success → emit tool.result with the (possibly artifact) output
//
// Design invariant (output separation): action.denied and tool.error are the
// audit-truth events; the returned text ToolOutput is the model-facing
// explanation. tool.result fires ONLY for real executions — denials never
// produce one, and the turn always continues with a text output.

import * as path from "node:path";
import type { ZodTypeAny } from "zod";
import type {
  ApprovalEngine,
  Engagement,
  Logger,
  PolicyEngine,
  Sandbox,
  ScopeTargetQuery,
  SessionEvent,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolOutput,
  ToolRegistry,
  ToolRouter,
  ToolSchema,
} from "@nyx/protocol";
import { toSerializedError } from "@nyx/protocol";
import { makeScopeChecker } from "@nyx/scope";
import { resolveContained } from "@nyx/sandbox";
import { jsonSchemaToZod } from "./jsonschema.js";
import { builtinInputSchemas } from "./schemas.js";
import { serializeForModel } from "./builtins.js";
import {
  ARTIFACTS_DIR,
  artifactAbsPath,
  ensureArtifactsDir,
  safeArtifactName,
} from "./artifacts.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 65_536;

/**
 * Which input fields are sandbox-relative paths, per builtin tool. Hard rule
 * #6: no handler-level path resolution — containment is enforced once, here.
 * Non-builtin tools are not in this map (their inputs pass through
 * unrewritten); a registration API for their path fields is deliberately
 * deferred (see README).
 */
const PATH_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["fs.read", ["path"]],
  ["fs.list", ["path"]],
  ["fs.write", ["path"]],
  ["shell.exec", []],
  ["web.fetch", []],
]);

/** Everything the caller supplies per call; the runtime adds routing, enforcement, and timing. */
export interface ToolExecContext {
  session_id: string;
  turn_id: string;
  /** Session's immutable engagement scope (from session meta). */
  engagement: Engagement | null;
  sandbox: Sandbox;
  signal: AbortSignal;
  logger: Logger;
  /** Routes events into the caller's event pump (loop appends to the store). */
  emit: (e: SessionEvent) => void;
}

export interface ToolRuntime {
  execute(
    call: ToolCall,
    ctx: ToolExecContext,
    opts?: { force_ask?: boolean },
  ): Promise<ToolOutput>;
  /** Curated, model-facing specs for CompletionRequest.tools. */
  specsForModel(): ToolSchema[];
}

export interface ToolRuntimeOptions {
  /** Per-call timeout when the tool definition has none. Default 30000. */
  default_timeout_ms?: number;
  /** Outputs whose model-facing serialization exceeds this spill into an artifact file. Default 65536. */
  max_output_bytes?: number;
}

export interface ToolRuntimeDeps {
  registry: ToolRegistry;
  router: ToolRouter;
  policy: PolicyEngine;
  approvals: ApprovalEngine;
  opts?: ToolRuntimeOptions;
}

class ToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`tool "${toolName}" timed out after ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
  }
}

interface EgressTarget {
  host: string;
  port?: number;
}

type EgressExtraction = { ok: true; target: EgressTarget } | { ok: false; reason: string };

/**
 * Extract the egress target from a tool input. web.fetch-style tools declare
 * a `url` (must be absolute http/https, no embedded userinfo — a scheme or
 * userinfo the operator never approved is a scope denial, not a validation
 * nit). Tools may alternatively declare `host` (+ optional `port`) directly;
 * an inline "host:port" authority is split the same way. Default http/https
 * ports are materialized so engagement port allowlists are actually checked.
 */
function extractEgressTarget(input: unknown): EgressExtraction {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      reason: "network egress requires an object input with a url or host field",
    };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.url === "string") {
    let url: URL;
    try {
      url = new URL(obj.url);
    } catch {
      return { ok: false, reason: `invalid url for network egress: ${JSON.stringify(obj.url)}` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        ok: false,
        reason: `network egress requires an http or https url, got ${JSON.stringify(url.protocol)}`,
      };
    }
    if (url.username !== "" || url.password !== "") {
      return {
        ok: false,
        reason: "urls with embedded userinfo are not allowed for network egress",
      };
    }
    // hostname keeps the [] wrapper for IPv6 literals; the scope checker's
    // normalizeHost unwraps it.
    if (url.hostname === "") {
      return { ok: false, reason: `url has no host: ${JSON.stringify(obj.url)}` };
    }
    const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return { ok: true, target: { host: url.hostname, port } };
  }

  if (typeof obj.host === "string" && obj.host !== "") {
    let host = obj.host.trim();
    let port = typeof obj.port === "number" ? obj.port : undefined;
    // A URL-style authority may carry the port inline ("example.com:22",
    // "[2001:db8::5]:443"). Materialize it so the engagement port policy is
    // actually evaluated — the scope checker's normalizeHost would otherwise
    // silently strip it, letting a denied port ride along unchecked. Bare
    // IPv6 (multiple colons) and non-numeric suffixes pass through untouched.
    const inline = splitInlinePort(host);
    if (inline !== null) {
      if (port !== undefined && port !== inline.port) {
        return {
          ok: false,
          reason: `network egress input declares conflicting ports (host says ${inline.port}, port field says ${port})`,
        };
      }
      host = inline.host;
      port = inline.port;
    }
    return { ok: true, target: { host, port } };
  }
  return {
    ok: false,
    reason: "network egress requires a url (http/https) or a host field in the tool input",
  };
}

/** Split "host:port" / "[v6]:port" into its parts; null when there is no inline port. */
function splitInlinePort(host: string): { host: string; port: number } | null {
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close > 0 && host.charAt(close + 1) === ":") {
      const suffix = host.slice(close + 2);
      if (/^\d+$/.test(suffix)) return { host: host.slice(0, close + 1), port: Number(suffix) };
    }
    return null;
  }
  const colon = host.indexOf(":");
  if (colon !== -1 && host.indexOf(":", colon + 1) === -1 && /^\d+$/.test(host.slice(colon + 1))) {
    return { host: host.slice(0, colon), port: Number(host.slice(colon + 1)) };
  }
  return null;
}

/** Rejects with the controller's abort reason the moment it fires (or immediately if it already has). */
function abortRace<T>(p: Promise<T>, controller: AbortController): Promise<T> {
  const aborted = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) {
      reject(controller.signal.reason);
      return;
    }
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
      once: true,
    });
  });
  return Promise.race([p, aborted]);
}

class ToolRuntimeImpl implements ToolRuntime {
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly router: ToolRouter,
    private readonly policy: PolicyEngine,
    private readonly approvals: ApprovalEngine,
    opts: ToolRuntimeOptions,
  ) {
    this.defaultTimeoutMs = opts.default_timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = opts.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  specsForModel(): ToolSchema[] {
    return this.registry.list().map((def) => ({
      name: def.name,
      description: def.description,
      input_schema: def.input_schema,
    }));
  }

  async execute(
    call: ToolCall,
    ctx: ToolExecContext,
    opts?: { force_ask?: boolean },
  ): Promise<ToolOutput> {
    const def = this.router.select(call, this.registry.list());
    const timeoutMs = def?.timeout_ms ?? this.defaultTimeoutMs;

    const controller = new AbortController();
    let timedOut = false;
    const timeoutReason = new ToolTimeoutError(call.name, timeoutMs);
    const onOuterAbort = (): void => controller.abort(ctx.signal.reason);
    if (ctx.signal.aborted) controller.abort(ctx.signal.reason);
    else ctx.signal.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutReason);
    }, timeoutMs);

    try {
      // 1. tool.call carries the ORIGINAL input — the audit log records what
      // the model asked for, not the contained form it will get.
      ctx.emit({
        type: "tool.call",
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
        call_id: call.call_id,
        name: call.name,
        input: call.input,
        ts: Date.now(),
      });

      // 2. unknown tool — the turn continues with a model-facing text.
      if (def === null) {
        this.emitUnknownTool(ctx, call);
        return { kind: "text", text: `error: unknown tool "${call.name}"` };
      }

      // 3. validation
      const parsed = this.schemaFor(def).safeParse(call.input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue !== undefined && issue.path.length > 0 ? issue.path.join(".") : "input";
        const message = issue !== undefined ? issue.message : "invalid input";
        const detail = `${where}: ${message}`;
        this.emitToolError(ctx, call, "ValidationError", detail, "validation_failed");
        return { kind: "text", text: `error: invalid input for "${def.name}": ${detail}` };
      }
      let input: unknown = parsed.data;

      // 4. path containment — before any handler runs (hard rule #6)
      const pathFields = PATH_FIELDS.get(def.name);
      if (
        pathFields !== undefined &&
        pathFields.length > 0 &&
        input !== null &&
        typeof input === "object" &&
        !Array.isArray(input)
      ) {
        const contained: Record<string, unknown> = { ...(input as Record<string, unknown>) };
        try {
          for (const field of pathFields) {
            const value = contained[field];
            if (typeof value === "string") {
              contained[field] = resolveContained(ctx.sandbox.workdir, value);
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.emitToolError(ctx, call, "PathEscapeError", message, "path_escape");
          return { kind: "text", text: "error: path escapes the sandbox workdir" };
        }
        input = contained;
      }

      // 5. scope check for egress-capable tools
      if (def.capabilities.includes("net.egress")) {
        const extraction = extractEgressTarget(input);
        if (!extraction.ok) {
          this.emitDenied(ctx, call, "scope", extraction.reason);
          return { kind: "text", text: `denied by scope: ${extraction.reason}` };
        }
        if (ctx.engagement === null) {
          const detail = "no engagement declared for this session; network egress denied";
          this.emitDenied(ctx, call, "scope", detail);
          return { kind: "text", text: `denied by scope: ${detail}` };
        }
        const check = makeScopeChecker(ctx.engagement);
        const query: ScopeTargetQuery =
          extraction.target.port !== undefined
            ? { host: extraction.target.host, port: extraction.target.port }
            : { host: extraction.target.host };
        const verdict = check(query);
        if (!verdict.allowed) {
          this.emitDenied(ctx, call, "scope", verdict.reason);
          return { kind: "text", text: `denied by scope: ${verdict.reason}` };
        }
      }

      // 6. policy
      const policyVerdict = await this.policy.evaluate({
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
        tool: def.name,
        // The digest binds the action that will actually execute: validated
        // and path-contained input, not the raw model request.
        input,
        risk: def.risk,
        capabilities: def.capabilities,
        actor_id: "agent",
      });
      if (policyVerdict.decision === "deny") {
        this.emitDenied(ctx, call, "policy", policyVerdict.summary, policyVerdict.rule_id);
        return {
          kind: "text",
          text: `denied by policy (rule ${policyVerdict.rule_id}): ${policyVerdict.summary}`,
        };
      }
      if (policyVerdict.decision === "ask" || opts?.force_ask === true) {
        // The approval engine blocks until resolved/expired; the SURFACE
        // emits approval.requested/resolved via onCreated/onResolved. This
        // runtime never sees or emits approval ids.
        const decision = await this.approvals.request(policyVerdict, {
          session_id: ctx.session_id,
          turn_id: ctx.turn_id,
          actor_id: "agent",
        });
        if (decision === "deny") {
          this.emitDenied(
            ctx,
            call,
            "approval",
            `approval denied for ${policyVerdict.summary}`,
            policyVerdict.rule_id,
          );
          return { kind: "text", text: "denied: approval was denied" };
        }
      }

      // 7. execute (the router matched by name; re-read the registry entry
      // for the handler so a mid-flight unregister cannot hand us a stale one)
      const entry = this.registry.get(def.name);
      if (entry === null) {
        this.emitUnknownTool(ctx, call);
        return { kind: "text", text: `error: unknown tool "${call.name}"` };
      }
      const handlerCtx: ToolContext = {
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
        call_id: call.call_id,
        sandbox: ctx.sandbox,
        signal: controller.signal,
        logger: ctx.logger,
        emit: ctx.emit,
        engagement: ctx.engagement,
      };
      const execCall: ToolCall = { call_id: call.call_id, name: call.name, input };

      let output: ToolOutput;
      try {
        output = await abortRace(entry.handler.execute(execCall, handlerCtx), controller);
      } catch (err) {
        return this.handleHandlerFailure(ctx, call, err, {
          timedOut,
          timeoutReason,
          timeoutMs,
          controller,
        });
      }

      // 8. truncation + artifact spill
      const finalOutput = await this.spillIfOversized(output, ctx, call.call_id);

      // 10. success
      ctx.emit({
        type: "tool.result",
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
        call_id: call.call_id,
        output: finalOutput,
        ts: Date.now(),
      });
      return finalOutput;
    } catch (err) {
      // Safety net: an unexpected failure in policy/approvals/spill/emission
      // must never reject — the turn continues with a tool_failed text.
      const serr = toSerializedError(err);
      ctx.logger.error(`tool "${call.name}" runtime failure`, {
        call_id: call.call_id,
        err: { name: serr.name, message: serr.message, stack: serr.stack },
      });
      this.emitToolError(ctx, call, serr.name, serr.message, "tool_failed");
      return { kind: "text", text: `error: tool "${call.name}" failed: ${serr.message}` };
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onOuterAbort);
    }
  }

  private handleHandlerFailure(
    ctx: ToolExecContext,
    call: ToolCall,
    err: unknown,
    state: {
      timedOut: boolean;
      timeoutReason: ToolTimeoutError;
      timeoutMs: number;
      controller: AbortController;
    },
  ): ToolOutput {
    const serr = toSerializedError(err);

    if (err === state.timeoutReason || state.timedOut) {
      const message = `tool "${call.name}" timed out after ${state.timeoutMs}ms`;
      ctx.logger.warn(`tool "${call.name}" timed out`, {
        call_id: call.call_id,
        timeout_ms: state.timeoutMs,
        err: { name: serr.name, message: serr.message },
      });
      this.emitToolError(ctx, call, "ToolTimeoutError", message, "tool_timeout");
      return { kind: "text", text: `error: ${message}` };
    }

    if (state.controller.signal.aborted) {
      // Outer cancellation (ctx.signal) — the turn is being torn down.
      ctx.logger.info(`tool "${call.name}" aborted`, {
        call_id: call.call_id,
        err: { name: serr.name, message: serr.message },
      });
      this.emitToolError(ctx, call, serr.name, serr.message, "aborted");
      return { kind: "text", text: `error: tool "${call.name}" aborted: ${serr.message}` };
    }

    // Full error (with stack) goes to the log; the event and the model-facing
    // text carry the message only.
    ctx.logger.error(`tool "${call.name}" failed`, {
      call_id: call.call_id,
      err: { name: serr.name, message: serr.message, stack: serr.stack },
    });
    this.emitToolError(ctx, call, serr.name, serr.message, "tool_failed");
    return { kind: "text", text: `error: tool "${call.name}" failed: ${serr.message}` };
  }

  private async spillIfOversized(
    output: ToolOutput,
    ctx: ToolExecContext,
    callId: string,
  ): Promise<ToolOutput> {
    const serialized = serializeForModel(output);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes <= this.maxOutputBytes) return output;
    const name = safeArtifactName(callId);
    await ensureArtifactsDir(ctx.sandbox);
    await ctx.sandbox.writeFile(path.posix.join(ARTIFACTS_DIR, `${name}.txt`), serialized);
    return {
      kind: "artifact",
      artifact_id: callId,
      path: artifactAbsPath(ctx.sandbox, name, ".txt"),
      bytes,
    };
  }

  /** Builtins validate with their zod schema; other tools compile their declared input_schema. */
  private schemaFor(def: ToolDefinition): ZodTypeAny {
    const builtin = builtinInputSchemas.get(def.name);
    if (builtin !== undefined) return builtin;
    return jsonSchemaToZod(def.input_schema);
  }

  private emitToolError(
    ctx: ToolExecContext,
    call: ToolCall,
    name: string,
    message: string,
    code: string,
  ): void {
    // No stack: the event log is transport-safe and audit-facing; the full
    // error is in the logger output.
    ctx.emit({
      type: "tool.error",
      session_id: ctx.session_id,
      turn_id: ctx.turn_id,
      call_id: call.call_id,
      error: { name, message, code },
      ts: Date.now(),
    });
  }

  private emitDenied(
    ctx: ToolExecContext,
    call: ToolCall,
    reason: "policy" | "approval" | "scope",
    detail: string,
    ruleId?: string,
  ): void {
    ctx.emit({
      type: "action.denied",
      session_id: ctx.session_id,
      turn_id: ctx.turn_id,
      call_id: call.call_id,
      reason,
      detail,
      ...(ruleId !== undefined ? { rule_id: ruleId } : {}),
      ts: Date.now(),
    });
  }

  private emitUnknownTool(ctx: ToolExecContext, call: ToolCall): void {
    this.emitToolError(
      ctx,
      call,
      "UnknownToolError",
      `unknown tool "${call.name}"`,
      "tool_unknown",
    );
  }
}

export function createToolRuntime(deps: ToolRuntimeDeps): ToolRuntime {
  return new ToolRuntimeImpl(
    deps.registry,
    deps.router,
    deps.policy,
    deps.approvals,
    deps.opts ?? {},
  );
}
