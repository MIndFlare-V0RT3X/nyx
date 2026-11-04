// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 4 §4 — the artifact handoff: the ONLY channel from a forked child
// sandbox back to its parent.
//
//   subagent_artifact       (child-side)  publishes a sandbox file into the
//                                       child's artifacts/ dir; the sha256
//                                       of the bytes is computed AT THE
//                                       WRITE SOURCE and recorded on the
//                                       hash-chained audit log.
//   subagent_read_artifact  (parent-side) copies a child artifact into the
//                                       PARENT's sandbox — only after
//                                       recomputing the hash and matching
//                                       it against the audited one. A
//                                       tampered or corrupted artifact
//                                       fails the read, loudly.
//
// Neither tool grants capabilities: subagent_artifact writes inside the
// child's own (already-granted) sandbox; subagent_read_artifact writes
// inside the parent's. The handoff is explicit, hashed, and audited — the
// opposite of the implicit filesystem sharing fork mode removed.

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { appendAudit, ensureAuditTable } from "@nyx/policy";
import { ARTIFACTS_DIR } from "@nyx/sandbox";
import type {
  Sandbox,
  ToolContext,
  ToolDefinition,
  ToolHandler,
  ToolRegistry,
} from "@nyx/protocol";
import { SubagentError } from "./errors.js";
import type { SubagentManager } from "./manager.js";

export const SUBAGENT_ARTIFACT_TOOL = "subagent_artifact";
export const SUBAGENT_READ_ARTIFACT_TOOL = "subagent_read_artifact";

/** Reads are fast; keep them on a short leash anyway. */
const ARTIFACT_TIMEOUT_MS = 60_000;

/** Max artifact name length (a basename, not a path traversal vector). */
const MAX_NAME_LEN = 128;

/**
 * The hard artifact size cap (both publish and read): the handoff buffers
 * whole files in memory, so the cap is the DoS bound (§6.2 R5-3).
 */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

/** Printable, single-line filename charset — control characters and bidi
 * overrides break transport line protocols and spoof listings (§6.2 R5-8).
 * (Square brackets deliberately excluded: a `]` inside a character class is
 * a foot-gun that silently truncates it.) */
const NAME_CHARSET = /^[A-Za-z0-9][A-Za-z0-9._+@ (),-]*$/;

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** A safe artifact name: a single printable path segment, no traversal. */
function safeArtifactName(name: string): string {
  if (
    name.length === 0 ||
    name.length > MAX_NAME_LEN ||
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".." ||
    !NAME_CHARSET.test(name) ||
    name.endsWith(".")
  ) {
    throw new SubagentError(
      "validation_failed",
      `artifact name must be a single printable path segment ` +
        `(letters, digits, . _ + @ space -; 1–${MAX_NAME_LEN} chars, no separators or control characters): got ${JSON.stringify(name)}`,
    );
  }
  return name;
}

/** Normalize a caller-supplied artifact reference to its bare name. */
export function artifactNameOf(path: string): string {
  const stripped = path.startsWith(`${ARTIFACTS_DIR}/`) ? path.slice(ARTIFACTS_DIR.length + 1) : path;
  return safeArtifactName(stripped);
}

export interface ArtifactWriteRecord {
  child_session_id: string;
  path: string;
  sha256: string;
  bytes: number;
}

/** Append the write-side audit row (hash computed at the write source). */
export function auditArtifactWritten(
  db: Database.Database,
  rec: ArtifactWriteRecord,
  now: () => number,
): void {
  appendAudit(
    db,
    {
      actor: "nyx:subagents",
      action: "subagent.artifact_written",
      payload: { ...rec },
    },
    { now },
  );
}

/**
 * The last audited write record for (child, name) — the hash a read must
 * reproduce. No audit trail (no db / never written) → undefined, and the
 * read REFUSES: unverifiable is not acceptable.
 */
export function lastWrittenHash(
  db: Database.Database | undefined,
  child_session_id: string,
  name: string,
): ArtifactWriteRecord | undefined {
  if (db === undefined) return undefined;
  ensureAuditTable(db); // idempotent — a bare handle may never have audited yet
  // SQL-side filter on the JSON payload (indexed — see ensureAuditTable's
  // expression index): the audit table is append-only and cross-process, a
  // full scan per read would grow without bound (§6.2 R5-4). Latest row for
  // the exact (child, path) pair wins — re-publishes append, never rewrite.
  const rows = db
    .prepare(
      "SELECT payload_json FROM audit WHERE action = 'subagent.artifact_written' " +
        "AND json_extract(payload_json, '$.child_session_id') = ? " +
        "AND json_extract(payload_json, '$.path') = ? ORDER BY id DESC LIMIT 1",
    )
    .all(child_session_id, name) as Array<{ payload_json: string }>;
  for (const row of rows) {
    return JSON.parse(row.payload_json) as ArtifactWriteRecord;
  }
  return undefined;
}

/** Append the read-side audit row (the verified handoff). */
export function auditArtifactRead(
  db: Database.Database,
  rec: {
    reader_session_id: string;
    child_session_id: string;
    path: string;
    dest: string;
    sha256: string;
    bytes: number;
  },
  now: () => number,
): void {
  appendAudit(
    db,
    {
      actor: "nyx:subagents",
      action: "subagent.artifact_read",
      payload: { ...rec },
    },
    { now },
  );
}

/**
 * The child-side tool definition + handler. `deps` carries exactly what the
 * handler may touch: its OWN sandbox, its session id, and the audit handle.
 */
export function subagentArtifactTool(deps: {
  sandbox: Sandbox;
  child_session_id: string;
  db: Database.Database | undefined;
  now: () => number;
}): { def: ToolDefinition; handler: ToolHandler } {
  const def: ToolDefinition = {
    name: SUBAGENT_ARTIFACT_TOOL,
    description:
      `Publish a file from your sandbox as an artifact for the parent. The file ` +
      `is COPIED into ${ARTIFACTS_DIR}/ with a sha256 recorded on the audit ` +
      `chain; the parent reads it with subagent_read_artifact. This is the ` +
      `only way files leave your sandbox.`,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file in your sandbox to publish." },
        name: { type: "string", description: "Artifact name (defaults to the file's basename)." },
      },
      required: ["path"],
    },
    risk: "R0",
    capabilities: [],
    handler: `builtin:${SUBAGENT_ARTIFACT_TOOL}`,
    concurrency: "parallel",
    timeout_ms: ARTIFACT_TIMEOUT_MS,
  };

  const handler: ToolHandler = {
    async execute(call): Promise<{ kind: "json"; json: unknown }> {
      const input = call.input as { path?: unknown; name?: unknown };
      if (
        typeof input.path !== "string" ||
        input.path.length === 0 ||
        (input.name !== undefined && typeof input.name !== "string")
      ) {
        throw new SubagentError(
          "validation_failed",
          "subagent_artifact input must be {path: string, name?: string}",
        );
      }
      const name = safeArtifactName(
        input.name !== undefined ? input.name : input.path.split("/").pop() ?? "",
      );
      if (name === "") {
        throw new SubagentError("validation_failed", "subagent_artifact: path has no basename");
      }
      // Read from the child's own sandbox (containment enforced by the
      // sandbox's own path checks) and write the copy into artifacts/ —
      // bounded by the hard artifact cap: the handoff buffers whole files
      // in memory (§6.2 R5-3).
      const content = await deps.sandbox.readFile(input.path);
      if (content.length > MAX_ARTIFACT_BYTES) {
        throw new SubagentError(
          "validation_failed",
          `artifact "${input.path}" is ${content.length} bytes — above the ${MAX_ARTIFACT_BYTES}-byte handoff cap`,
        );
      }
      const dest = `${ARTIFACTS_DIR}/${name}`;
      await deps.sandbox.writeFile(dest, content);
      const rec: ArtifactWriteRecord = {
        child_session_id: deps.child_session_id,
        path: name,
        sha256: sha256Hex(content),
        bytes: content.length,
      };
      if (deps.db !== undefined) auditArtifactWritten(deps.db, rec, deps.now);
      return { kind: "json", json: { path: dest, bytes: rec.bytes, sha256: rec.sha256 } };
    },
  };
  return { def, handler };
}

/**
 * A ToolRegistry view that ADDS a fixed set of tools on top of an inner
 * (filtered) registry — the fork-mode extras (subagent_artifact). The
 * extras bypass the allowlist BY CONSTRUCTION: they are harness-granted,
 * not model-requested. register/unregister delegate inward (the loop never
 * calls them); list() surfaces the extras FIRST so the child model
 * reliably discovers the handoff channel.
 */
export class ExtraToolsRegistry implements ToolRegistry {
  constructor(
    private readonly inner: ToolRegistry,
    private readonly extras: Array<{ def: ToolDefinition; handler: ToolHandler }>,
  ) {}

  register(def: ToolDefinition, handler: ToolHandler): void {
    this.inner.register(def, handler);
  }

  unregister(name: string): void {
    this.inner.unregister(name);
  }

  list(): ToolDefinition[] {
    const extraNames = new Set(this.extras.map((e) => e.def.name));
    return [...this.extras.map((e) => e.def), ...this.inner.list().filter((d) => !extraNames.has(d.name))];
  }

  get(name: string): { def: ToolDefinition; handler: ToolHandler } | null {
    const extra = this.extras.find((e) => e.def.name === name);
    if (extra !== undefined) return extra;
    return this.inner.get(name);
  }
}

/** Back-compat alias: the single-tool constructor shape used by callers. */
export class ArtifactToolRegistry extends ExtraToolsRegistry {
  constructor(
    inner: ToolRegistry,
    artifact: { def: ToolDefinition; handler: ToolHandler },
  ) {
    super(inner, [artifact]);
  }
}

/**
 * Register the PARENT-side subagent_read_artifact tool (fork mode only — in
 * inherit mode there is no child sandbox to read from, and the tool's
 * absence is the honest catalog). Surfaces gate the call on
 * sandbox_sharing; the read itself is parentage-checked per call in the
 * manager (§6.2 R5-1).
 */
export function registerSubagentArtifactTools(
  registry: ToolRegistry,
  deps: { manager: SubagentManager },
): void {
  const def: ToolDefinition = {
    name: SUBAGENT_READ_ARTIFACT_TOOL,
    description:
      "Copy an artifact a subagent published into your sandbox. The bytes are " +
      "verified against the sha256 recorded when the subagent wrote them — a " +
      "tampered artifact fails this read.",
    input_schema: {
      type: "object",
      properties: {
        subagent_session_id: { type: "string", description: "The subagent's session id." },
        path: {
          type: "string",
          description: "Artifact name or path as listed on the subagent's result (e.g. artifacts/report.md).",
        },
        dest: {
          type: "string",
          description: "Destination path in your sandbox (default: artifacts/<name>).",
        },
      },
      required: ["subagent_session_id", "path"],
    },
    risk: "R0",
    capabilities: [],
    handler: `builtin:${SUBAGENT_READ_ARTIFACT_TOOL}`,
    concurrency: "parallel",
    timeout_ms: ARTIFACT_TIMEOUT_MS,
  };

  const handler: ToolHandler = {
    async execute(call, ctx: ToolContext): Promise<{ kind: "json"; json: unknown }> {
      const input = call.input as {
        subagent_session_id?: unknown;
        path?: unknown;
        dest?: unknown;
      };
      if (
        typeof input.subagent_session_id !== "string" ||
        input.subagent_session_id.length === 0 ||
        typeof input.path !== "string" ||
        input.path.length === 0 ||
        (input.dest !== undefined && (typeof input.dest !== "string" || input.dest.length === 0))
      ) {
        throw new SubagentError(
          "validation_failed",
          "subagent_read_artifact input must be {subagent_session_id: string, path: string, dest?: string}",
        );
      }
      const bound = deps.manager.boundTurn(ctx.session_id, ctx.turn_id);
      if (bound === undefined) {
        throw new SubagentError(
          "no_parent_context",
          `subagent_read_artifact: no bound turn context for session ${ctx.session_id} turn ${ctx.turn_id}`,
        );
      }
      const out = await deps.manager.readChildArtifact(
        input.subagent_session_id,
        input.path,
        input.dest,
        ctx.session_id,
        bound.ctx,
      );
      return { kind: "json", json: out };
    },
  };

  registry.register(def, handler);
}
