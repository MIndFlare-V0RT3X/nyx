// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { entryToMarkdown, parseMemoryFile, MemoryValidationError } from "./frontmatter.js";
import type { MemoryEntry } from "@nyx/protocol";

const entry: MemoryEntry = {
  id: "V1StGXR8_Z5jdHi6B-myT",
  scope: "persona",
  kind: "fact",
  content: "primary db runs postgres 16 with streaming replication\n",
  tags: ["database", "infra"],
  source: { session_id: "sess-1", turn_id: "turn-9" },
  created_at: 1700000000000,
  updated_at: 1700000000000,
};

describe("frontmatter round-trip", () => {
  it("serializes and parses back to an identical entry", () => {
    const md = entryToMarkdown(entry);
    expect(md.startsWith("---\n")).toBe(true);
    const parsed = parseMemoryFile("/tmp/m/persona/V1.md", md);
    expect(parsed).toEqual(entry);
  });

  it("normalizes CRLF on parse", () => {
    const md = entryToMarkdown(entry).replace(/\n/g, "\r\n");
    expect(parseMemoryFile("/tmp/m/persona/V1.md", md)).toEqual(entry);
  });
});

describe("malformed frontmatter", () => {
  it("bad YAML names the file path and the file line", () => {
    const md = [
      "---",
      "id: abc123",
      "scope: persona",
      "tags: [unclosed",
      "---",
      "content",
      "",
    ].join("\n");
    // frontmatter starts on file line 2; "tags" is frontmatter line 3 = file line 4.
    expect(() => parseMemoryFile("/tmp/m/persona/bad1.md", md)).toThrowError(
      /\/tmp\/m\/persona\/bad1\.md.*\(line 4\)/,
    );
  });

  it("missing required key names the file path and the key", () => {
    const md = ["---", "id: abc123", "scope: persona", "---", "content"].join("\n");
    try {
      parseMemoryFile("/tmp/m/persona/bad2.md", md);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryValidationError);
      const e = err as MemoryValidationError;
      expect(e.code).toBe("validation_failed");
      expect(e.message).toContain("/tmp/m/persona/bad2.md");
      expect(e.message).toContain('"kind"');
    }
  });

  it("wrong type names the file path and the key's line", () => {
    const md = [
      "---",
      "id: abc123",
      "scope: persona",
      "kind: fact",
      "tags: []",
      "source: {}",
      "created_at: not-a-number",
      "updated_at: 1700000000000",
      "---",
      "content",
    ].join("\n");
    expect(() => parseMemoryFile("/tmp/m/persona/bad3.md", md)).toThrowError(
      /\/tmp\/m\/persona\/bad3\.md.*created_at.*\(line 7\)/,
    );
  });

  it("bad scope enum is rejected with path and line", () => {
    const md = [
      "---",
      "id: abc123",
      "scope: everywhere",
      "kind: fact",
      "tags: []",
      "source: {}",
      "created_at: 1",
      "updated_at: 1",
      "---",
      "c",
    ].join("\n");
    expect(() => parseMemoryFile("/tmp/m/persona/bad4.md", md)).toThrowError(
      /bad4\.md.*scope.*\(line 3\)/,
    );
  });

  it("missing opening delimiter is rejected", () => {
    expect(() => parseMemoryFile("/tmp/m/persona/bad5.md", "no frontmatter here")).toThrowError(
      /bad5\.md.*opening "---"/,
    );
  });

  it("missing closing delimiter is rejected", () => {
    const md = ["---", "id: abc123"].join("\n");
    expect(() => parseMemoryFile("/tmp/m/persona/bad6.md", md)).toThrowError(
      /bad6\.md.*closing "---"/,
    );
  });

  it("non-mapping frontmatter is rejected", () => {
    const md = ["---", "- just", "- a list", "---", "content"].join("\n");
    expect(() => parseMemoryFile("/tmp/m/persona/bad7.md", md)).toThrowError(/bad7\.md.*mapping/);
  });
});
