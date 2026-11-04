// SPDX-License-Identifier: AGPL-3.0-or-later
// The builtin tool set: fs.read, fs.list, fs.write, shell.exec, web.fetch.
//
// Handlers only ever touch the sandbox they are given (`ctx.sandbox`); by the
// time a handler runs, the runtime has already validated the input, resolved
// every path field against the workdir, checked the engagement scope for
// net.egress tools, and passed policy + approvals. web.fetch is the one
// deliberate exception on I/O: it performs the HTTP exchange in-process (see
// the README for the justification and the documented limitations). Its HTTP
// redirects are followed MANUALLY, one hop at a time, because every hop is a
// fresh network action that must independently pass the engagement scope
// check — fetch's built-in `redirect: "follow"` would connect to the
// Location host with no check at all.

import * as path from "node:path";
import { makeScopeChecker } from "@nyx/scope";
import type {
  Capability,
  Engagement,
  RiskTier,
  ToolDefinition,
  ToolHandler,
  ToolOutput,
  ToolRegistry,
} from "@nyx/protocol";
import { zodToJsonSchema } from "./jsonschema.js";
import {
  builtinInputSchemas,
  fsListInput,
  fsReadInput,
  fsWriteInput,
  shellExecInput,
  webFetchInput,
} from "./schemas.js";
import {
  ARTIFACTS_DIR,
  artifactAbsPath,
  ensureArtifactsDir,
  safeArtifactName,
} from "./artifacts.js";

const DEFAULT_FETCH_MAX_BYTES = 1_048_576;
/** web.fetch gets a tighter wall clock than the 30s tool default. */
const WEB_FETCH_TIMEOUT_MS = 15_000;
/** Redirect hops are scope-checked individually; cap well under fetch's 20. */
const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

function builtinDef(
  name: string,
  description: string,
  risk: RiskTier,
  capabilities: Capability[],
  timeout_ms?: number,
): ToolDefinition {
  const schema = builtinInputSchemas.get(name);
  if (schema === undefined) {
    throw new Error(`no zod input schema registered for builtin "${name}"`);
  }
  return {
    name,
    description,
    input_schema: zodToJsonSchema(schema),
    risk,
    capabilities,
    handler: `builtin:${name}`,
    ...(timeout_ms !== undefined ? { timeout_ms } : {}),
  };
}

/**
 * Binary heuristic: a NUL byte anywhere, or more than 10% control bytes
 * (excluding tab/LF/CR; DEL counts). Bytes >= 0x80 count as printable so
 * UTF-8 text stays text.
 */
function looksBinary(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  if (buf.length === 0) return false;
  let nonPrintable = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) nonPrintable++;
  }
  return nonPrintable * 10 > buf.length;
}

const fsReadHandler: ToolHandler = {
  async execute(call, ctx) {
    const input = fsReadInput.parse(call.input);
    const content = await ctx.sandbox.readFile(input.path);
    if (looksBinary(content)) {
      return {
        kind: "file",
        path: input.path,
        bytes: content.length,
        mime: "application/octet-stream",
      };
    }
    return { kind: "text", text: content.toString("utf8") };
  },
};

const fsListHandler: ToolHandler = {
  async execute(call, ctx) {
    const input = fsListInput.parse(call.input);
    const entries = await ctx.sandbox.list(input.path);
    return { kind: "json", json: entries };
  },
};

const fsWriteHandler: ToolHandler = {
  async execute(call, ctx) {
    const input = fsWriteInput.parse(call.input);
    await ctx.sandbox.writeFile(input.path, input.content);
    return {
      kind: "json",
      json: { path: input.path, bytes: Buffer.byteLength(input.content, "utf8") },
    };
  },
};

const shellExecHandler: ToolHandler = {
  async execute(call, ctx) {
    const input = shellExecInput.parse(call.input);
    const r = await ctx.sandbox.exec(
      input.cmd,
      input.timeout_ms !== undefined ? { timeout_ms: input.timeout_ms } : {},
    );
    // A non-zero exit is a result, not a failure: the command ran and the
    // exit code is data the model needs to see.
    return {
      kind: "text",
      text: `exit ${r.exit_code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    };
  },
};

/** Text-ish content types are inlined; everything else spills to an artifact. */
function isTextualContentType(contentType: string): boolean {
  const t = contentType.split(";")[0]!.trim().toLowerCase();
  return (
    t.startsWith("text/") ||
    t === "application/json" ||
    t.endsWith("+json") ||
    t === "application/xml" ||
    t.endsWith("+xml") ||
    t === "application/yaml" ||
    t === "application/x-yaml" ||
    t.endsWith("+yaml")
  );
}

/**
 * Read the body up to `cap` bytes, then cancel the stream. Stops one chunk
 * past the cap so an exactly-`cap`-byte body is not flagged as truncated.
 */
async function readBodyCapped(
  res: Response,
  cap: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  if (res.body === null) return { body: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    chunks.push(Buffer.from(value));
    received += value.byteLength;
    if (received > cap) {
      truncated = true;
      break;
    }
  }
  await reader.cancel().catch(() => undefined);
  const full = Buffer.concat(chunks);
  return { body: full.length > cap ? full.subarray(0, cap) : full, truncated };
}

/**
 * Scope-check one redirect hop (deny-first). The Location target is a network
 * action the operator never approved by name, so it faces the same engagement
 * scope check the runtime applied to the original url — same host/port
 * extraction semantics (default ports materialized, bracketed IPv6 kept for
 * normalizeHost to unwrap). Returns a denial reason or null when allowed.
 */
function redirectScopeDenial(engagement: Engagement | null, target: URL): string | null {
  if (engagement === null) {
    return "no engagement declared for this session; network egress denied";
  }
  const port = target.port !== "" ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
  const verdict = makeScopeChecker(engagement)({ host: target.hostname, port });
  if (!verdict.allowed) {
    return `redirect to ${target.host} denied: ${verdict.reason}`;
  }
  return null;
}

const webFetchHandler: ToolHandler = {
  async execute(call, ctx) {
    const input = webFetchInput.parse(call.input);
    const cap = input.max_bytes ?? DEFAULT_FETCH_MAX_BYTES;

    // Redirects are followed manually: fetch(redirect: "follow") would
    // connect to the Location host with no scope check, letting an in-scope
    // url pivot egress to any out-of-scope host. Each hop below re-validates
    // scheme, userinfo, and engagement scope before any connection is made.
    // ctx.signal is the runtime's timeout-linked signal, so every fetch dies
    // with the tool call.
    let current = new URL(input.url);
    let res: Response;
    for (let hop = 0; ; hop++) {
      res = await fetch(current, { signal: ctx.signal, redirect: "manual" });
      if (!REDIRECT_STATUSES.has(res.status)) break;
      const location = res.headers.get("location");
      if (location === null) break; // malformed redirect: surface as-is, like fetch
      if (res.body !== null) await res.body.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECT_HOPS) {
        throw new Error(`too many redirects (limit ${MAX_REDIRECT_HOPS}) fetching ${input.url}`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error(`invalid redirect location "${location}" from ${current.origin}`);
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new Error(`redirect to non-http(s) scheme ${next.protocol} is not allowed`);
      }
      if (next.username !== "" || next.password !== "") {
        throw new Error("redirects to urls with embedded userinfo are not allowed");
      }
      const denial = redirectScopeDenial(ctx.engagement, next);
      if (denial !== null) {
        // Audit-truth first (same shape as the runtime's scope denials), then
        // fail the call — denials never produce a tool.result.
        ctx.emit({
          type: "action.denied",
          session_id: ctx.session_id,
          turn_id: ctx.turn_id,
          call_id: call.call_id,
          reason: "scope",
          detail: `denied by scope: ${denial}`,
          ts: Date.now(),
        });
        throw new Error(`denied by scope: ${denial}`);
      }
      current = next;
    }
    if (res.status >= 400) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    }
    const contentType = res.headers.get("content-type") ?? "";
    const { body, truncated } = await readBodyCapped(res, cap);

    if (isTextualContentType(contentType)) {
      const text = body.toString("utf8") + (truncated ? `\n\n[truncated after ${cap} bytes]` : "");
      return {
        kind: "text",
        text: `fetched ${input.url} [${res.status} ${contentType}]\n\n${text}`,
      };
    }

    await ensureArtifactsDir(ctx.sandbox);
    const name = safeArtifactName(call.call_id);
    await ctx.sandbox.writeFile(path.posix.join(ARTIFACTS_DIR, `${name}.bin`), body);
    return {
      kind: "artifact",
      artifact_id: call.call_id,
      path: artifactAbsPath(ctx.sandbox, name, ".bin"),
      bytes: body.length,
    };
  },
};

/** Register the five builtin tools (fs.read, fs.list, fs.write, shell.exec, web.fetch). */
export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(
    builtinDef(
      "fs.read",
      "Read a file from the session sandbox. `path` is resolved against the sandbox working directory; paths that escape it are rejected before this tool runs. Text files come back as text; binary files come back as a file descriptor with path, size, and mime type.",
      "R0",
      ["fs.read"],
    ),
    fsReadHandler,
  );
  registry.register(
    builtinDef(
      "fs.list",
      'List a directory in the session sandbox. `path` is resolved against the sandbox working directory and defaults to ".". Returns a JSON array of entries: { name, type: "file" | "dir", size } (size in bytes, 0 for directories).',
      "R0",
      ["fs.read"],
    ),
    fsListHandler,
  );
  registry.register(
    builtinDef(
      "fs.write",
      "Write a UTF-8 text file inside the session sandbox (existing files are overwritten). `path` is resolved against the sandbox working directory; the parent directory must already exist. Returns the resolved path and the byte count written.",
      "R1",
      ["fs.write"],
    ),
    fsWriteHandler,
  );
  registry.register(
    builtinDef(
      "shell.exec",
      "Run a shell command inside the session sandbox (bash -c, working directory = sandbox root) and capture stdout, stderr, and the exit code. A non-zero exit code is returned as a normal result. Optionally pass timeout_ms for a wall-clock kill (the command tree gets SIGKILL; the exit code is then 137).",
      "R3",
      ["proc.spawn"],
    ),
    shellExecHandler,
  );
  registry.register(
    builtinDef(
      "web.fetch",
      'Fetch an HTTP(S) URL. Only http/https with no embedded userinfo is accepted, the target host must be inside the session\'s engagement scope, and every fetch passes the policy engine (an "ask" verdict pauses for operator approval). HTTP redirects are followed only when every hop stays inside the engagement scope (max 5). Text-like responses (text/*, JSON, XML, YAML) come back inline; binary responses are stored as an artifact file in the sandbox.',
      "R2",
      ["net.egress"],
      WEB_FETCH_TIMEOUT_MS,
    ),
    webFetchHandler,
  );
}

/** Serialized for the artifact-spill size check and artifact files. */
export function serializeForModel(output: ToolOutput): string {
  switch (output.kind) {
    case "text":
      return output.text;
    case "json":
      return output.json === undefined ? "null" : JSON.stringify(output.json, null, 2);
    case "file":
      return `${output.path} (${output.bytes} bytes, ${output.mime})`;
    case "artifact":
      return `${output.path} (${output.bytes} bytes)`;
  }
}
