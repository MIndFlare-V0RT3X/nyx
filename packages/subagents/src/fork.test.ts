// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 4 §4 acceptance — fork-per-child on the REAL local provider: the
// child's sandbox is a copy that shares nothing with the parent, the ONLY
// handoff is subagent_artifact → subagent_read_artifact with the sha256
// recorded on the audit chain at the write source and re-verified at the
// read end, and tampered/unknown/unaudited artifacts are refused.

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "@nyx/policy";
import type { Sandbox, ToolContext } from "@nyx/protocol";
import { LocalSandboxProvider } from "@nyx/sandbox";
import {
  SUBAGENT_ARTIFACT_TOOL,
  SUBAGENT_READ_ARTIFACT_TOOL,
  registerSubagentArtifactTools,
} from "./artifacts.js";
import { makeSubagentHarness, type SubagentHarness } from "./harness.test.js";
import { mockTextTurn } from "@nyx/model";

/** The parent's pre-fork seed — what the forked children inherit and publish. */
const SEED = "the parent's pre-fork state";
const provider = new LocalSandboxProvider();
const sandboxes: Sandbox[] = [];
const dbs: Database.Database[] = [];
const harnesses: SubagentHarness[] = [];

afterAll(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close();
  while (sandboxes.length > 0) await sandboxes.pop()!.destroy().catch(() => undefined);
  while (dbs.length > 0) dbs.pop()!.close();
});

async function makeForkHarness(
  seedFile = true,
  config: Record<string, unknown> = {},
): Promise<{
  h: SubagentHarness;
  parentSandbox: Sandbox;
  db: Database.Database;
}> {
  const parentSandbox = await provider.provision({
    provider: "local",
    workdir: "",
    network: "none",
  });
  sandboxes.push(parentSandbox);
  if (seedFile) {
    await parentSandbox.writeFile("seed.txt", SEED);
  }
  const db = new Database(":memory:");
  db.pragma("busy_timeout = 5000");
  dbs.push(db);
  const h = await makeSubagentHarness({
    config: { sandbox_sharing: "fork", ...config },
    parentSandbox,
    managerDeps: { db },
  });
  harnesses.push(h);
  registerSubagentArtifactTools(h.toolRegistry, { manager: h.manager });
  return { h, parentSandbox, db };
}

/** A child turn that publishes the inherited seed.txt as `name` then finishes. */
function artifactTurn(name: string): Parameters<SubagentHarness["provider"]["script"]>[1] {
  return [
    [
      {
        type: "tool_call.delta",
        index: 0,
        id: "a1",
        name: SUBAGENT_ARTIFACT_TOOL,
        arguments_delta: JSON.stringify({ path: "seed.txt", name }),
      },
      { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      { type: "done", finish_reason: "tool_calls" },
    ],
    mockTextTurn("published the artifact"),
  ];
}

function fakeCtx(h: SubagentHarness, turn = "t1"): ToolContext {
  return {
    session_id: h.parent.session_id,
    turn_id: turn,
    call_id: "read1",
  } as unknown as ToolContext;
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

describe("fork-per-child (§4.4)", () => {
  it("the child's sandbox is a copy of the parent's, isolated in both directions", async () => {
    const { h, parentSandbox } = await makeForkHarness();
    h.provider.script("isolation-check", [
      [
        {
          type: "tool_call.delta",
          index: 0,
          id: "w1",
          name: "fs.write",
          arguments_delta: '{"path":"child-wrote.txt","content":"from the child"}',
        },
        { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        { type: "done", finish_reason: "tool_calls" },
      ],
      mockTextTurn("wrote a file"),
    ]);

    const result = await h.manager.spawn(
      { task: "isolation-check" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    expect(result.state).toBe("completed");
    expect(result.artifacts).toEqual([]);

    // The child saw the parent's pre-fork state (the fork is a copy)…
    const childCtx = h.capturedContexts.get(result.session_id)!;
    expect(childCtx).toBeDefined();
    expect((await childCtx.sandbox.readFile("seed.txt")).toString("utf8")).toBe(
      "the parent's pre-fork state",
    );
    // …but its writes never reached the parent.
    await expect(parentSandbox.readFile("child-wrote.txt")).rejects.toThrow();
    // And the parent is not the child's sandbox.
    expect(childCtx.sandbox.id).not.toBe(parentSandbox.id);
  });

  it("subagent_artifact publishes into artifacts/, audited with the content hash", async () => {
    const { h, db } = await makeForkHarness();
    h.provider.script("publish report", artifactTurn("report.md"));

    const result = await h.manager.spawn(
      { task: "publish report" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    expect(result.state).toBe("completed");
    // The artifact rides on the result with path + bytes.
    expect(result.artifacts).toEqual([{ path: "artifacts/report.md", bytes: SEED.length }]);

    // The audit row carries the write-source hash.
    const rows = db
      .prepare("SELECT payload_json FROM audit WHERE action = 'subagent.artifact_written'")
      .all() as Array<{ payload_json: string }>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload_json) as {
      child_session_id: string;
      path: string;
      sha256: string;
      bytes: number;
    };
    expect(payload.child_session_id).toBe(result.session_id);
    expect(payload.path).toBe("report.md");
    expect(payload.bytes).toBe(SEED.length);
    expect(payload.sha256).toBe(sha256(Buffer.from(SEED)));

    // The tool's result event carries the same facts.
    const childEvents = await h.store.read(result.session_id);
    const toolOk = childEvents.find((e) => e.type === "tool.result");
    expect(toolOk).toMatchObject({ call_id: "a1" });

    expect(verifyAuditChain(db).ok).toBe(true);
  });

  it("subagent_read_artifact copies into the parent sandbox, hash-verified and audited", async () => {
    const { h, parentSandbox, db } = await makeForkHarness();
    h.provider.script("handoff", artifactTurn("result.txt"));

    const result = await h.manager.spawn(
      { task: "handoff" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    h.manager.bindTurn(h.parent.session_id, "read-turn", h.parentCtx);

    const handler = h.toolRegistry.get(SUBAGENT_READ_ARTIFACT_TOOL)!.handler;
    const out = await handler.execute(
      {
        call_id: "read1",
        name: SUBAGENT_READ_ARTIFACT_TOOL,
        input: { subagent_session_id: result.session_id, path: "artifacts/result.txt" },
      },
      fakeCtx(h, "read-turn"),
    );
    expect(out).toMatchObject({ kind: "json" });
    const json = (out as { json: { dest: string; bytes: number; sha256: string } }).json;
    expect(json.bytes).toBe(SEED.length);
    expect(json.sha256).toBe(sha256(Buffer.from(SEED)));

    // The bytes actually landed in the PARENT's sandbox.
    expect((await parentSandbox.readFile(json.dest)).toString("utf8")).toBe(SEED);

    // The read is on the audit chain too.
    const reads = db
      .prepare("SELECT payload_json FROM audit WHERE action = 'subagent.artifact_read'")
      .all() as Array<{ payload_json: string }>;
    expect(reads).toHaveLength(1);
    expect(JSON.parse(reads[0]!.payload_json)).toMatchObject({
      child_session_id: result.session_id,
      path: "result.txt",
    });
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  it("a TAMPERED artifact fails the read (hash mismatch), loudly", async () => {
    const { h } = await makeForkHarness();
    h.provider.script("tamper-me", artifactTurn("shady.txt"));
    const result = await h.manager.spawn(
      { task: "tamper-me" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );

    // Something mutated the artifact inside the child sandbox AFTER the
    // audited write (operator error, disk corruption, an attacker with
    // sandbox access).
    const childCtx = h.capturedContexts.get(result.session_id)!;
    await childCtx.sandbox.writeFile("artifacts/shady.txt", "TAMPERED");

    h.manager.bindTurn(h.parent.session_id, "read-turn", h.parentCtx);
    const handler = h.toolRegistry.get(SUBAGENT_READ_ARTIFACT_TOOL)!.handler;
    await expect(
      handler.execute(
        {
          call_id: "read1",
          name: SUBAGENT_READ_ARTIFACT_TOOL,
          input: { subagent_session_id: result.session_id, path: "shady.txt" },
        },
        fakeCtx(h, "read-turn"),
      ),
    ).rejects.toMatchObject({ code: "artifact_integrity" });
  });

  it("unknown children and unaudited artifacts are refused", async () => {
    const { h } = await makeForkHarness();
    h.provider.script("any", artifactTurn("ok.txt"));
    const result = await h.manager.spawn(
      { task: "any" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    h.manager.bindTurn(h.parent.session_id, "read-turn", h.parentCtx);
    const handler = h.toolRegistry.get(SUBAGENT_READ_ARTIFACT_TOOL)!.handler;

    // Unknown child session.
    await expect(
      handler.execute(
        {
          call_id: "r",
          name: SUBAGENT_READ_ARTIFACT_TOOL,
          input: { subagent_session_id: "nope", path: "ok.txt" },
        },
        fakeCtx(h, "read-turn"),
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    // A file in artifacts/ that was never published through the tool — no
    // audit row, no hash to verify: refused.
    const childCtx = h.capturedContexts.get(result.session_id)!;
    await childCtx.sandbox.writeFile("artifacts/smuggled.txt", "not audited");
    await expect(
      handler.execute(
        {
          call_id: "r",
          name: SUBAGENT_READ_ARTIFACT_TOOL,
          input: { subagent_session_id: result.session_id, path: "smuggled.txt" },
        },
        fakeCtx(h, "read-turn"),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("past the retention cap, the oldest child sandbox is reaped and reads fail not_found", async () => {
    // 9 same-turn spawns need the per-turn ceiling raised (default budget
    // 32768 × 9 > the default 200000 cap).
    const { h } = await makeForkHarness(true, { max_total_per_turn: 2_000_000 });
    h.provider.script("cap-first", artifactTurn("first.txt"));
    const first = await h.manager.spawn(
      { task: "cap-first" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    expect(first.artifacts).toEqual([{ path: "artifacts/first.txt", bytes: SEED.length }]);

    // 8 more spawns evict the first (cap 8, LRU).
    for (let i = 0; i < 8; i++) {
      h.provider.script(`cap-extra-${i}`, artifactTurn(`f${i}.txt`));
      const r = await h.manager.spawn(
        { task: `cap-extra-${i}` },
        h.parentCtx,
        { session_id: h.parent.session_id, turn_id: "t1" },
      );
      expect(r.state).toBe("completed");
    }

    h.manager.bindTurn(h.parent.session_id, "read-turn", h.parentCtx);
    const handler = h.toolRegistry.get(SUBAGENT_READ_ARTIFACT_TOOL)!.handler;
    await expect(
      handler.execute(
        {
          call_id: "r",
          name: SUBAGENT_READ_ARTIFACT_TOOL,
          input: { subagent_session_id: first.session_id, path: "first.txt" },
        },
        fakeCtx(h, "read-turn"),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("inherit mode: the shared sandbox, no artifact channel, artifacts = []", async () => {
    // The harness default pins inherit semantics for the Phase 3 suites.
    const h = await makeSubagentHarness({});
    h.provider.script("inherit-mode", artifactTurn("whatever.txt"));
    const result = await h.manager.spawn(
      { task: "inherit-mode" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    // The child shares the parent's sandbox object.
    const childCtx = h.capturedContexts.get(result.session_id)!;
    expect(childCtx.sandbox).toBe(h.parentCtx.sandbox);
    // subagent_artifact is NOT in the child's registry in inherit mode.
    expect(childCtx.tools.get(SUBAGENT_ARTIFACT_TOOL)).toBeNull();
    // The tool call resolved as unknown.
    const childEvents = await h.store.read(result.session_id);
    expect(childEvents.some((e) => e.type === "tool.error")).toBe(true);
    expect(result.artifacts).toEqual([]);
  });
});
