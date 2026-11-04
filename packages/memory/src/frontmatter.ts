// SPDX-License-Identifier: AGPL-3.0-or-later
// Markdown frontmatter parse/serialize for memory files. The file is the
// source of truth; the SQLite index mirrors it (see store.ts for the lazy
// reindex-on-mismatch strategy).
//
// File shape (CRLF is normalized to LF on parse):
//   ---
//   id: <nanoid>
//   scope: persona
//   kind: fact
//   tags: [security, prefs]
//   source: { "session_id": "..." }
//   created_at: 1700000000000
//   updated_at: 1700000000000
//   ---
//   <content — the memory body>

import YAML from "yaml";
import type { MemoryEntry, MemoryScope } from "@nyx/protocol";

export class MemoryValidationError extends Error {
  readonly code = "validation_failed" as const;

  constructor(message: string) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

const SCOPES: readonly string[] = ["session", "persona", "owner", "global", "subagent"];
const KINDS: readonly string[] = ["fact", "preference", "procedure", "episode", "skill-note"];
const SOURCE_KEYS = ["session_id", "turn_id", "path"] as const;

/**
 * Serialize an entry to its markdown representation. Key order is fixed so
 * files are byte-stable for identical entries.
 */
export function entryToMarkdown(entry: MemoryEntry): string {
  const frontmatter = YAML.stringify({
    id: entry.id,
    scope: entry.scope,
    kind: entry.kind,
    tags: entry.tags,
    source: entry.source,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  });
  return `---\n${frontmatter}---\n${entry.content}`;
}

/**
 * Parse a memory markdown file into a MemoryEntry. Any malformed frontmatter
 * (bad YAML, missing keys, wrong types) throws a MemoryValidationError whose
 * message names the file path and, when a line number is known, the file line
 * the problem is on (parser-supplied lines are rebased to file coordinates:
 * the frontmatter block starts on file line 2).
 */
export function parseMemoryFile(filePath: string, text: string): MemoryEntry {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trimEnd() !== "---") {
    fail(filePath, 'missing opening "---" frontmatter delimiter');
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trimEnd() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    fail(filePath, 'missing closing "---" frontmatter delimiter');
  }
  const fmLines = lines.slice(1, closeIdx);
  const content = lines.slice(closeIdx + 1).join("\n");

  let raw: unknown;
  try {
    raw = YAML.parse(fmLines.join("\n"));
  } catch (err) {
    const yamlLine = parserLine(err);
    const detail =
      err instanceof Error ? (err.message.split("\n")[0] ?? "").replace(/:\s*$/, "") : String(err);
    fail(
      filePath,
      `invalid YAML in frontmatter: ${detail}`,
      yamlLine !== undefined ? yamlLine + 1 : undefined,
    );
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, "frontmatter must be a YAML mapping");
  }
  const fm = raw as Record<string, unknown>;

  if (typeof fm.id !== "string" || fm.id.length === 0) {
    fail(filePath, 'frontmatter key "id" must be a non-empty string', keyLine(fmLines, "id"));
  }
  if (typeof fm.scope !== "string" || !SCOPES.includes(fm.scope)) {
    fail(
      filePath,
      `frontmatter key "scope" must be one of ${SCOPES.join("|")}`,
      keyLine(fmLines, "scope"),
    );
  }
  if (typeof fm.kind !== "string" || !KINDS.includes(fm.kind)) {
    fail(
      filePath,
      `frontmatter key "kind" must be one of ${KINDS.join("|")}`,
      keyLine(fmLines, "kind"),
    );
  }
  if (!Array.isArray(fm.tags) || fm.tags.some((t) => typeof t !== "string")) {
    fail(filePath, 'frontmatter key "tags" must be a list of strings', keyLine(fmLines, "tags"));
  }
  if (typeof fm.source !== "object" || fm.source === null || Array.isArray(fm.source)) {
    fail(filePath, 'frontmatter key "source" must be a mapping', keyLine(fmLines, "source"));
  } else {
    const source = fm.source as Record<string, unknown>;
    for (const key of SOURCE_KEYS) {
      const v = source[key];
      if (v !== undefined && typeof v !== "string") {
        fail(
          filePath,
          `frontmatter key "source.${key}" must be a string when present`,
          keyLine(fmLines, "source"),
        );
      }
    }
  }
  for (const key of ["created_at", "updated_at"]) {
    const v = fm[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      fail(filePath, `frontmatter key "${key}" must be a finite number`, keyLine(fmLines, key));
    }
  }

  return {
    id: fm.id,
    scope: fm.scope as MemoryScope,
    kind: fm.kind as MemoryEntry["kind"],
    content,
    tags: [...(fm.tags as string[])],
    source: fm.source as MemoryEntry["source"],
    created_at: fm.created_at as number,
    updated_at: fm.updated_at as number,
  };
}

function fail(filePath: string, reason: string, line?: number): never {
  const at = line !== undefined ? ` (line ${line})` : "";
  throw new MemoryValidationError(`${filePath}: ${reason}${at}`);
}

/** File-relative (1-based) line of a frontmatter key, when present. */
function keyLine(fmLines: string[], key: string): number | undefined {
  const re = new RegExp(`^\\s*${key}\\s*:`);
  for (let i = 0; i < fmLines.length; i++) {
    if (re.test(fmLines[i] ?? "")) return i + 2; // +2: line 1 is the opening ---
  }
  return undefined;
}

/**
 * Line number from a yaml parser error, when it supplies one. yaml v2 exposes
 * YAMLParseError.linePos (array of {line,col}); some builds use numeric
 * `.line`. Returned values are frontmatter-relative and must be rebased by
 * the caller.
 */
function parserLine(err: unknown): number | undefined {
  const e = err as { line?: unknown; linePos?: unknown };
  if (typeof e.line === "number") return e.line;
  const lp = e.linePos;
  if (Array.isArray(lp)) {
    const first = lp[0] as { line?: unknown } | undefined;
    if (first && typeof first.line === "number") return first.line;
  } else if (
    lp !== null &&
    typeof lp === "object" &&
    typeof (lp as { line?: unknown }).line === "number"
  ) {
    return (lp as { line: number }).line;
  }
  return undefined;
}
