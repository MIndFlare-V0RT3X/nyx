// SPDX-License-Identifier: AGPL-3.0-or-later
// Persona loading: a persona is a directory with persona.yaml plus four
// markdown files (SOUL, CONTRACT, USER, MEMORY). The yaml is validated with
// Zod; the markdown files are carried verbatim into the system prompt by
// @nyx/persona/runtime.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export class PersonaLoadError extends Error {
  readonly code = "validation_failed" as const;

  constructor(message: string) {
    super(message);
    this.name = "PersonaLoadError";
  }
}

/**
 * Structured persona config, matching personas/default/persona.yaml exactly.
 * Every object uses .passthrough() so a newer persona file with extra fields
 * still loads (forward compatibility) — unknown keys are kept, never dropped
 * by surprise.
 */
export const PersonaSchema = z
  .object({
    schema: z.literal(1),
    id: z.string(),
    name: z.string(),
    pronouns: z.string().optional(),
    tagline: z.string().optional(),
    voice: z
      .object({
        register: z.enum(["close", "peer", "cold"]),
        verbosity: z.enum(["terse", "normal", "expansive"]),
        humor: z.string().optional(),
        profanity: z.string().optional(),
        lowercase_in_chat: z.boolean().optional(),
        proper_case_in_deliverables: z.boolean().optional(),
      })
      .passthrough(),
    cognition: z
      .object({
        planning: z.enum(["auto", "always", "never"]),
        self_check: z.boolean().optional(),
        cite_sources: z.boolean().optional(),
        verify_before_claim: z.boolean().optional(),
        state_uncertainty: z.boolean().optional(),
      })
      .passthrough(),
    contract: z
      .object({
        precedence: z.string().optional(),
        honesty: z
          .object({
            never_fabricate: z.boolean().optional(),
            evidence_required: z.boolean().optional(),
            no_completion_without_verification: z.boolean().optional(),
          })
          .passthrough(),
        scope: z
          .object({
            enforce_engagement: z.boolean().optional(),
            deny_out_of_scope: z.boolean().optional(),
            one_line_reason: z.boolean().optional(),
          })
          .passthrough(),
        escalate: z.array(z.string()),
        always: z.array(z.string()),
      })
      .passthrough(),
    capabilities: z
      .object({
        domains: z.array(z.string()),
        tools_allow: z.array(z.string()),
        tools_deny: z.array(z.string()),
      })
      .passthrough(),
    memory: z
      .object({
        auto_write: z.boolean().optional(),
        review_after_turn: z.boolean().optional(),
        scopes: z.array(z.string()),
      })
      .passthrough(),
  })
  .passthrough();

export type PersonaConfig = z.infer<typeof PersonaSchema>;

/** A persona directory loaded into memory. Markdown is verbatim file content. */
export interface LoadedPersona {
  config: PersonaConfig;
  soul_md: string;
  contract_md: string;
  user_md: string;
  memory_md: string;
}

const PERSONA_FILES = ["persona.yaml", "SOUL.md", "CONTRACT.md", "USER.md", "MEMORY.md"] as const;

/**
 * Load `<personasRoot>/<id>/`: reads persona.yaml, validates it against
 * PersonaSchema, then reads the four markdown companions. A missing file
 * throws PersonaLoadError (code "validation_failed") naming the missing file
 * path; invalid yaml or a schema mismatch throws with the offending field
 * paths in the message.
 */
export async function loadPersona(personasRoot: string, id: string): Promise<LoadedPersona> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new PersonaLoadError(`invalid persona id: ${JSON.stringify(id)}`);
  }
  const dir = path.join(personasRoot, id);
  const paths = new Map<string, string>(
    PERSONA_FILES.map((name) => [name, path.join(dir, name)] as const),
  );

  const read = async (name: (typeof PERSONA_FILES)[number]): Promise<string> => {
    const file = paths.get(name)!;
    try {
      return await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PersonaLoadError(`missing persona file: ${file}`);
      }
      throw err;
    }
  };

  const yamlPath = paths.get("persona.yaml")!;
  let raw: unknown;
  try {
    raw = YAML.parse(await read("persona.yaml"));
  } catch (err) {
    if (err instanceof PersonaLoadError) throw err;
    const detail = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
    throw new PersonaLoadError(`${yamlPath}: invalid YAML: ${detail}`);
  }
  const parsed = PersonaSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${yamlPath}: persona.${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new PersonaLoadError(issues);
  }

  // Sequential reads so a partial persona reports the first missing file in
  // a deterministic order (persona.yaml, SOUL, CONTRACT, USER, MEMORY).
  const soul_md = await read("SOUL.md");
  const contract_md = await read("CONTRACT.md");
  const user_md = await read("USER.md");
  const memory_md = await read("MEMORY.md");
  return { config: parsed.data, soul_md, contract_md, user_md, memory_md };
}
