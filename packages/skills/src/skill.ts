// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 4 §4.4 — SKILL.md: a progressive-disclosure skill package.
//
// A skill is a directory containing a SKILL.md: a YAML frontmatter block
// (name, description, when_to_use, tools, persona_scope, version — all
// except name/description optional) followed by a Markdown body (the actual
// instructions, loaded on demand by the load_skill tool). The FRONTMATTER
// is what the model sees up front (the catalog, ~50–100 tokens per skill);
// the BODY is what it pulls when a task matches — the same titles-only
// pattern the memory catalog uses.
//
// A malformed skill is a WARNING, never a session failure: the entry is
// refused and logged, the rest of the catalog loads.

import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** The frontmatter contract. `tools` is informational in Phase 4: parsed,
 * validated, and surfaced in the catalog — runtime tool GATING is Phase 5. */
export const SkillFrontmatterSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase kebab-case"),
    description: z.string().min(8).max(300),
    when_to_use: z.string().min(3).max(300).optional(),
    tools: z.array(z.string().min(1)).max(32).optional(),
    persona_scope: z.array(z.string().min(1)).max(64).optional(),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, "semantic version (MAJOR.MINOR.PATCH)")
      .optional(),
  })
  .strict();

export interface SkillEntry {
  name: string;
  description: string;
  when_to_use?: string;
  tools?: string[];
  persona_scope?: string[];
  version?: string;
  /** The instruction body — returned by load_skill, never in the catalog. */
  body: string;
  /** Absolute path of the SKILL.md this came from (diagnostics). */
  file: string;
}

export type ParseResult =
  | { ok: true; skill: SkillEntry }
  | { ok: false; file: string; warning: string };

/** Split a SKILL.md into its frontmatter text and body. */
function splitFrontmatter(text: string): { fm: string; body: string } | { error: string } {
  if (!text.startsWith("---\n")) {
    return { error: "file must start with a `---` frontmatter block" };
  }
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    return { error: "unterminated frontmatter block (missing closing `---`)" };
  }
  return { fm: text.slice(4, end), body: text.slice(end + 5) };
}

/**
 * Parse and validate one SKILL.md. Any structural, YAML, schema, or body
 * problem is a warning-shaped refusal — malformed entries never break the
 * session, they just don't ship.
 */
export function parseSkillMd(text: string, file: string): ParseResult {
  const split = splitFrontmatter(text);
  if ("error" in split) return { ok: false, file, warning: split.error };
  const { fm, body } = split;

  let raw: unknown;
  try {
    raw = parseYaml(fm);
  } catch (err) {
    return {
      ok: false,
      file,
      warning: `frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, file, warning: "frontmatter must be a YAML mapping" };
  }

  const parsed = SkillFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      file,
      warning: `frontmatter invalid: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
        .join("; ")}`,
    };
  }

  const stripped = body.trim();
  if (stripped.length === 0) {
    return { ok: false, file, warning: "body is empty — a skill with no instructions ships nothing" };
  }
  if (stripped.length > 512 * 1024) {
    return { ok: false, file, warning: `body is ${stripped.length} bytes — above the 512KiB cap` };
  }

  const s = parsed.data;
  return {
    ok: true,
    skill: {
      name: s.name,
      description: s.description,
      ...(s.when_to_use !== undefined ? { when_to_use: s.when_to_use } : {}),
      ...(s.tools !== undefined ? { tools: [...s.tools] } : {}),
      ...(s.persona_scope !== undefined ? { persona_scope: [...s.persona_scope] } : {}),
      ...(s.version !== undefined ? { version: s.version } : {}),
      body: stripped,
      file,
    },
  };
}
