// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStoreImpl, MemoryValidationError } from "./index.js";
import type { MemoryEntry } from "@nyx/protocol";

const roots: string[] = [];
const stores: MemoryStoreImpl[] = [];

afterAll(() => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function makeStore(opts: { episode_expiry_days?: number } = {}): { store: MemoryStoreImpl; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-memory-test-"));
  roots.push(root);
  const store = new MemoryStoreImpl(root, opts);
  stores.push(store);
  return { store, root };
}

function entryPath(root: string, entry: Pick<MemoryEntry, "id" | "scope">): string {
  return path.join(root, entry.scope, `${entry.id}.md`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("write", () => {
  it("returns a full entry and creates a parseable file plus index row", async () => {
    const { store, root } = makeStore();
    const written = await store.write({
      scope: "persona",
      kind: "fact",
      content: "primary db runs postgres 16",
      tags: ["database"],
      source: { session_id: "s1" },
    });
    expect(typeof written.id).toBe("string");
    expect(written.id.length).toBeGreaterThan(10);
    expect(written.created_at).toBeGreaterThan(0);
    expect(written.updated_at).toBe(written.created_at);
    const file = entryPath(root, written);
    expect(fs.existsSync(file)).toBe(true);
    expect(await store.get(written.id)).toEqual(written);
    expect((await store.list()).length).toBe(1);
  });

  it("rejects a bad scope with a validation_failed error", async () => {
    const { store } = makeStore();
    await expect(
      store.write({
        scope: "everywhere" as MemoryEntry["scope"],
        kind: "fact",
        content: "x",
        tags: [],
        source: {},
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("search", () => {
  it("finds entries by a content word", async () => {
    const { store } = makeStore();
    await store.write({
      scope: "global",
      kind: "fact",
      content: "the vpn concentrator lives at 10.0.0.9",
      tags: [],
      source: {},
    });
    const results = await store.search("vpn");
    expect(results.length).toBe(1);
    expect(results[0]!.content).toContain("vpn concentrator");
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it("ranks a tagged entry above an equally relevant untagged one (1.5x boost)", async () => {
    const { store } = makeStore();
    const untagged = await store.write({
      scope: "global",
      kind: "fact",
      content: "the database sharding strategy uses sixteen logical shards",
      tags: ["infra"],
      source: {},
    });
    const tagged = await store.write({
      scope: "global",
      kind: "fact",
      content: "the database sharding strategy uses sixteen logical shards",
      tags: ["database"],
      source: {},
    });
    const results = await store.search("database");
    expect(results.length).toBe(2);
    expect(results[0]!.id).toBe(tagged.id);
    expect(results[1]!.id).toBe(untagged.id);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("applies exactly 1.5x when the tag match is the only difference", async () => {
    // "databases" contains the query term (boost applies) but does not
    // tokenize to it (no FTS tag-column match), so both entries share the
    // same base bm25 and the only delta is the multiplier.
    const { store } = makeStore();
    const boosted = await store.write({
      scope: "global",
      kind: "fact",
      content: "the database sharding strategy uses sixteen logical shards",
      tags: ["databases"],
      source: {},
    });
    const plain = await store.write({
      scope: "global",
      kind: "fact",
      content: "the database sharding strategy uses sixteen logical shards",
      tags: ["networks"],
      source: {},
    });
    const results = await store.search("database");
    expect(results.length).toBe(2);
    expect(results[0]!.id).toBe(boosted.id);
    expect(results[1]!.id).toBe(plain.id);
    expect(results[0]!.score / results[1]!.score).toBeCloseTo(1.5, 5);
  });

  it("matches on tag terms too (FTS over content+tags)", async () => {
    const { store } = makeStore();
    await store.write({
      scope: "owner",
      kind: "preference",
      content: "prefers concise answers with citations",
      tags: ["communication-style"],
      source: {},
    });
    expect((await store.search("communication-style")).length).toBe(1);
  });

  it("filters by scope list", async () => {
    const { store } = makeStore();
    await store.write({ scope: "persona", kind: "fact", content: "likes the dracula theme", tags: [], source: {} });
    await store.write({ scope: "global", kind: "fact", content: "likes the dracula theme", tags: [], source: {} });
    await store.write({ scope: "session", kind: "fact", content: "likes the dracula theme", tags: [], source: {} });
    const personaOnly = await store.search("dracula", { scope: ["persona"] });
    expect(personaOnly.length).toBe(1);
    expect(personaOnly[0]!.scope).toBe("persona");
    const two = await store.search("dracula", { scope: ["persona", "global"] });
    expect(two.length).toBe(2);
    expect(new Set(two.map((e) => e.scope))).toEqual(new Set(["persona", "global"]));
  });

  it("applies min_score", async () => {
    const { store } = makeStore();
    await store.write({ scope: "global", kind: "fact", content: "kubernetes cluster runs three control plane nodes", tags: [], source: {} });
    const all = await store.search("control plane");
    expect(all.length).toBe(1);
    const none = await store.search("control plane", { min_score: 1e9 });
    expect(none).toEqual([]);
  });

  it("ANDs multiple terms and honors limit", async () => {
    const { store } = makeStore();
    for (let i = 0; i < 5; i++) {
      await store.write({ scope: "global", kind: "fact", content: `release artifact number ${i} is signed`, tags: [], source: {} });
    }
    expect((await store.search("release signed")).length).toBe(5);
    expect((await store.search("release signed", { limit: 2 })).length).toBe(2);
    expect((await store.search("release unsigned")).length).toBe(0);
  });

  it("FTS injection attempts do not throw", async () => {
    const { store } = makeStore();
    await store.write({ scope: "global", kind: "fact", content: "some ordinary memory content", tags: [], source: {} });
    await expect(store.search('query)"')).resolves.toEqual([]);
    await expect(store.search('foo"bar')).resolves.toEqual([]);
    await expect(store.search("NEAR(a b)")).resolves.toEqual([]);
    await expect(store.search("*")).resolves.toEqual([]);
    await expect(store.search("   ")).resolves.toEqual([]);
  });
});

describe("get", () => {
  it("returns null for unknown ids and rejects unsafe ids", async () => {
    const { store } = makeStore();
    expect(await store.get("nonexistent")).toBeNull();
    expect(await store.get("../../etc/passwd")).toBeNull();
  });

  it("returns file content after a hand edit and search reflects the reindexed row", async () => {
    const { store, root } = makeStore();
    const written = await store.write({
      scope: "persona",
      kind: "fact",
      content: "the vault seal is quarterly",
      tags: ["security"],
      source: {},
    });
    const file = entryPath(root, written);
    await sleep(5);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("the vault seal is quarterly", "the vault seal is annual and audited"), "utf8");

    const got = await store.get(written.id);
    expect(got?.content).toBe("the vault seal is annual and audited");
    expect(got?.tags).toEqual(["security"]);

    // the drifted row was lazily reindexed: search now finds the new word
    const results = await store.search("audited");
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe(written.id);
    // and the old word no longer matches the index
    expect((await store.search("quarterly")).length).toBe(0);
  });

  it("finds a file with no index row (index lost, file kept)", async () => {
    const { store, root } = makeStore();
    const written = await store.write({
      scope: "global",
      kind: "fact",
      content: "orphaned but recoverable",
      tags: [],
      source: {},
    });
    fs.rmSync(path.join(root, "index.sqlite"));
    fs.rmSync(path.join(root, "index.sqlite-wal"), { force: true });
    fs.rmSync(path.join(root, "index.sqlite-shm"), { force: true });
    stores.pop(); // the old handle points at a deleted db file
    const reopened = new MemoryStoreImpl(root);
    stores.push(reopened);
    const got = await reopened.get(written.id);
    expect(got?.content).toBe("orphaned but recoverable");
    expect((await reopened.search("orphaned")).length).toBe(1);
  });

  it("throws a validation_failed error naming path and line for malformed frontmatter", async () => {
    const { store, root } = makeStore();
    const id = "badfrontmatter01";
    const file = path.join(root, "persona", `${id}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      ["---", "id: " + id, "scope: persona", "tags: [unclosed", "---", "broken"].join("\n"),
      "utf8",
    );
    try {
      await store.get(id);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryValidationError);
      const e = err as MemoryValidationError;
      expect(e.code).toBe("validation_failed");
      expect(e.message).toContain(file);
      expect(e.message).toMatch(/line 4/);
    }
  });
});

describe("list", () => {
  it("filters by scope and kind, orders by updated_at desc", async () => {
    const { store } = makeStore();
    const a = await store.write({ scope: "global", kind: "fact", content: "fact one", tags: [], source: {} });
    await sleep(10);
    const b = await store.write({ scope: "persona", kind: "preference", content: "pref two", tags: [], source: {} });
    await sleep(10);
    const c = await store.write({ scope: "global", kind: "episode", content: "episode three", tags: [], source: {} });

    const all = await store.list();
    expect(all.map((e) => e.id)).toEqual([c.id, b.id, a.id]);

    const globalOnly = await store.list({ scope: ["global"] });
    expect(globalOnly.map((e) => e.id)).toEqual([c.id, a.id]);

    const facts = await store.list({ kind: "fact" });
    expect(facts.map((e) => e.id)).toEqual([a.id]);

    expect((await store.list({ limit: 1 })).length).toBe(1);
  });
});

describe("compact", () => {
  it("merges duplicate facts: union tags, newest timestamp wins, merged=1", async () => {
    const { store, root } = makeStore();
    const older = await store.write({
      scope: "persona",
      kind: "fact",
      content: "The   vault seal is QUARTERLY.",
      tags: ["security"],
      source: { session_id: "s-old" },
    });
    await sleep(15);
    const newer = await store.write({
      scope: "persona",
      kind: "fact",
      content: "the vault seal is quarterly",
      tags: ["compliance"],
      source: { session_id: "s-new" },
    });

    const result = await store.compact();
    expect(result).toEqual({ merged: 1, dropped: 0 });

    const remaining = await store.list({ kind: "fact" });
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.id).toBe(newer.id);
    expect(remaining[0]!.updated_at).toBe(newer.updated_at);
    expect([...remaining[0]!.tags].sort()).toEqual(["compliance", "security"]);
    expect(fs.existsSync(entryPath(root, older))).toBe(false);
    expect(fs.existsSync(entryPath(root, newer))).toBe(true);
    // the merged file itself carries the union
    const got = await store.get(newer.id);
    expect([...got!.tags].sort()).toEqual(["compliance", "security"]);
    // and search still finds it under a tag term
    expect((await store.search("security")).length).toBe(1);
  });

  it("does not merge facts across scopes or kinds", async () => {
    const { store } = makeStore();
    await store.write({ scope: "persona", kind: "fact", content: "identical wording", tags: [], source: {} });
    await store.write({ scope: "global", kind: "fact", content: "identical wording", tags: [], source: {} });
    await store.write({ scope: "persona", kind: "preference", content: "identical wording", tags: [], source: {} });
    const result = await store.compact();
    expect(result.merged).toBe(0);
    expect((await store.list()).length).toBe(3);
  });

  it("archives expired episodes to <root>/expired/<scope>/ and reports dropped", async () => {
    const { store, root } = makeStore({ episode_expiry_days: 30 });
    const episode = await store.write({
      scope: "session",
      kind: "episode",
      content: "walked the operator through a pcap triage",
      tags: [],
      source: { session_id: "s-ep" },
    });
    const freshFact = await store.write({
      scope: "persona",
      kind: "fact",
      content: "a durable fact that must survive compaction",
      tags: [],
      source: {},
    });
    const freshEpisode = await store.write({
      scope: "session",
      kind: "episode",
      content: "a recent episode that must survive compaction",
      tags: [],
      source: {},
    });

    // age the episode by injecting an old created_at directly into file+row
    const file = entryPath(root, episode);
    await sleep(5);
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace(/created_at: \d+/, "created_at: 1600000000000")
        .replace(/updated_at: \d+/, "updated_at: 1600000000000"),
      "utf8",
    );
    // get() reads the file (source of truth) and lazily reindexes the row
    const refreshed = await store.get(episode.id);
    expect(refreshed?.created_at).toBe(1600000000000);

    const result = await store.compact();
    expect(result).toEqual({ merged: 0, dropped: 1 });

    const expiredPath = path.join(root, "expired", "session", `${episode.id}.md`);
    expect(fs.existsSync(expiredPath)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(await store.get(episode.id)).toBeNull();
    expect((await store.list()).map((e) => e.id).sort()).toEqual([freshFact.id, freshEpisode.id].sort());
  });
});

describe("embedder seam", () => {
  it("accepts an embedder option without changing search behavior", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-memory-test-"));
    roots.push(root);
    const store = new MemoryStoreImpl(root, { embedder: { embed: async () => [0.1, 0.2] } });
    stores.push(store);
    await store.write({ scope: "global", kind: "fact", content: "embedding seam content", tags: [], source: {} });
    expect((await store.search("seam")).length).toBe(1);
    store.close();
  });
});
