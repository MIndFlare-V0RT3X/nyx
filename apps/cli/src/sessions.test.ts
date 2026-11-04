// SPDX-License-Identifier: AGPL-3.0-or-later
// `nyx sessions` acceptance: list (id, title, turns, updated), show
// (messages + tool-call summary, or --events), fork (child id, identical
// event prefix), against a store seeded with real turns.

import { describe, expect, it } from "vitest";
import { mockTextTurn, mockToolTurn } from "@nyx/model";
import {
  forkSession,
  listSessions,
  renderSessionDetail,
  renderSessionEvents,
  renderSessionList,
  showSession,
} from "./sessions.js";
import {
  loopbackEngagement,
  loopbackServer,
  makeRig,
  scriptedMock,
  until,
} from "./harness.test.js";
import { runOneShot } from "./run.js";
import { captureOutput } from "./harness.test.js";

async function seedTwoTurnSession(rig: Awaited<ReturnType<typeof makeRig>>): Promise<string> {
  const out = captureOutput();
  const first = await runOneShot({
    config: rig.config,
    data_dir: rig.dirs.data,
    message: "first turn",
    providers: [
      scriptedMock([
        mockToolTurn({ call_id: "c1", name: "fs.write", input: { path: "a.txt", content: "x" } }),
        mockTextTurn("first reply"),
      ]),
    ],
    stdout: out.stdout,
    stderr: out.stderr,
  });
  expect(first.exit_code).toBe(0);
  const second = await runOneShot({
    config: rig.config,
    data_dir: rig.dirs.data,
    message: "second turn",
    session_id: first.session_id,
    providers: [scriptedMock([mockTextTurn("second reply")])],
    stdout: out.stdout,
    stderr: out.stderr,
  });
  expect(second.exit_code).toBe(0);
  return first.session_id;
}

describe("sessions", () => {
  it("list shows id, title, turns, updated for each session", async () => {
    const rig = await makeRig();
    await seedTwoTurnSession(rig);
    const rows = await listSessions(rig.dirs.data);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("first turn");
    expect(rows[0]?.turns).toBe(2);
    expect(rows[0]?.updated_at).toBeGreaterThan(0);
    const rendered = renderSessionList(rows);
    expect(rendered).toContain("session");
    expect(rendered).toContain("first turn");
    expect(rendered).toContain("2");
  });

  it("show renders messages, tool calls, and usage from the projection", async () => {
    const rig = await makeRig();
    const id = await seedTwoTurnSession(rig);
    const detail = await showSession(rig.dirs.data, id);
    expect(detail.meta.session_id).toBe(id);
    const rendered = renderSessionDetail(detail);
    expect(rendered).toContain("[user] first turn");
    expect(rendered).toContain("[assistant] first reply");
    expect(rendered).toContain("[assistant] second reply");
    expect(rendered).toContain("fs.write");
    expect(rendered).toContain("ok");
    expect(rendered).toContain("usage");
  });

  it("show --events renders the raw event log in seq order", async () => {
    const rig = await makeRig();
    const id = await seedTwoTurnSession(rig);
    const detail = await showSession(rig.dirs.data, id);
    const rendered = renderSessionEvents(detail);
    const types = detail.events.map((e) => e.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("text.delta");
    expect(types).toContain("tool.call");
    expect(types).toContain("tool.result");
    expect(types).toContain("turn.completed");
    expect(rendered).toContain("turn.started");
    expect(rendered).toContain("tool.call");
    // seq order preserved in the rendering
    const seqs = detail.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("fork prints the child id; the child's event prefix matches the parent", async () => {
    const rig = await makeRig();
    const parentId = await seedTwoTurnSession(rig);
    const parentDetail = await showSession(rig.dirs.data, parentId);
    const lastSeq = parentDetail.events[parentDetail.events.length - 1]?.seq ?? 0;
    const child = await forkSession(rig.dirs.data, parentId, lastSeq);
    expect(child.session_id).not.toBe(parentId);
    expect(child.parent_id).toBe(parentId);

    const childDetail = await showSession(rig.dirs.data, child.session_id);
    expect(childDetail.events.map((e) => e.type)).toEqual(parentDetail.events.map((e) => e.type));
    // The parent's log records the fork.
    const refreshedParent = await showSession(rig.dirs.data, parentId);
    expect(refreshedParent.events.some((e) => e.type === "session.forked")).toBe(true);
  });

  it("fork refuses an at_seq past the end and an unknown session", async () => {
    const rig = await makeRig();
    const id = await seedTwoTurnSession(rig);
    await expect(forkSession(rig.dirs.data, id, 99_999)).rejects.toThrow(
      /past the session's last event/,
    );
    await expect(forkSession(rig.dirs.data, "no-such-session", 1)).rejects.toThrow(/not found/);
  });

  it("show on a session with an engagement renders it", async () => {
    const rig = await makeRig();
    const server = await loopbackServer("body");
    try {
      const out = captureOutput();
      const result = await runOneShot({
        config: rig.config,
        data_dir: rig.dirs.data,
        message: "with engagement",
        engagement: loopbackEngagement(),
        providers: [scriptedMock([mockTextTurn("ok")])],
        stdout: out.stdout,
        stderr: out.stderr,
      });
      await until(async () => (await listSessions(rig.dirs.data)).length === 1);
      const rendered = renderSessionDetail(await showSession(rig.dirs.data, result.session_id));
      expect(rendered).toContain("engagement ENG-TEST-1");
    } finally {
      await server.close();
    }
  });
});
