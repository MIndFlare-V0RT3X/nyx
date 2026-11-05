// SPDX-License-Identifier: AGPL-3.0-or-later
// The load_skill tool (Phase 4 §4.4) — progressive disclosure's pull side.
//
// R0, capabilities []: a skill is TRUSTED CONTENT, not a tool — loading its
// body grants no authority the session didn't already have (the skill's
// `tools` field is informational in Phase 4; gating is Phase 5). The body
// returns as a tool.result TEXT block; the load lands on the session's
// event log as skill.loaded; re-loads in the same session are refused with
// already_loaded; a scope mismatch with scope_mismatch. Both refusals are
// tool ERRORS (the model sees them), not throws.

import type { ToolContext, ToolDefinition, ToolHandler, ToolRegistry } from "@nyx/protocol";
import type { SkillsProvider } from "./provider.js";

export const LOAD_SKILL_TOOL = "load_skill";

/** Skills are content; loading is quick. Generous tool clock anyway. */
const LOAD_TIMEOUT_MS = 30_000;

function skillError(
  code: "already_loaded" | "scope_mismatch" | "not_found",
  message: string,
): Error {
  const err = new Error(message) as Error & { code: string };
  err.name = "SkillError";
  err.code = code;
  return err;
}

/** The model-facing input schema. */
export const LOAD_SKILL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "The skill to load, exactly as named in the skills catalog.",
    },
  },
  required: ["name"],
} as const;

export interface LoadSkillInput {
  name: string;
}

function isLoadInput(value: unknown): value is LoadSkillInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (!("name" in v) || typeof v.name !== "string" || v.name.length === 0) return false;
  return keys.every((k) => k === "name");
}

export interface RegisterLoadSkillDeps {
  provider: SkillsProvider;
  /** Persona resolution for the calling session (defaults to the store). */
  personaOf?: (session_id: string) => Promise<string>;
}

/**
 * Register load_skill on the registry. The handler resolves the session's
 * persona (the provider's store by default), enforces the loaded/scope
 * contracts, emits skill.loaded, and returns the BODY as a text block.
 */
export function registerLoadSkillTool(registry: ToolRegistry, deps: RegisterLoadSkillDeps): void {
  const def: ToolDefinition = {
    name: LOAD_SKILL_TOOL,
    description:
      "Load a skill's full instructions from the skills catalog. The body " +
      "arrives as this tool's result; use it to guide your work. Loading a " +
      "skill grants no tools or permissions — it is documentation.",
    input_schema: LOAD_SKILL_INPUT_SCHEMA,
    // Trusted content, no external side effects: R0, no capabilities.
    risk: "R0",
    capabilities: [],
    handler: `builtin:${LOAD_SKILL_TOOL}`,
    concurrency: "parallel",
    timeout_ms: LOAD_TIMEOUT_MS,
  };

  const personaOf =
    deps.personaOf ??
    (async (session_id: string): Promise<string> => {
      const meta = await deps.provider.sessionMeta(session_id);
      return meta?.persona_id ?? "default";
    });

  const handler: ToolHandler = {
    async execute(call, ctx: ToolContext): Promise<{ kind: "text"; text: string }> {
      if (!isLoadInput(call.input)) {
        throw skillError("not_found", "load_skill input must be {name: string}");
      }
      const name = call.input.name;
      const persona_id = await personaOf(ctx.session_id);
      const found = await deps.provider.skillFor(ctx.session_id, persona_id, name);
      if (found === null) {
        throw skillError("not_found", `no skill named "${name}" — check the skills catalog`);
      }
      if (!found.visible) {
        throw skillError(
          "scope_mismatch",
          `skill "${name}" is not scoped to persona "${persona_id}" (or needs capabilities this session lacks)`,
        );
      }
      if (deps.provider.isLoaded(ctx.session_id, name)) {
        throw skillError(
          "already_loaded",
          `skill "${name}" is already loaded in this session — its body is in the earlier tool result`,
        );
      }
      deps.provider.markLoaded(ctx.session_id, name);
      ctx.emit({
        type: "skill.loaded",
        session_id: ctx.session_id,
        name,
        version: found.skill.version ?? null,
        ts: Date.now(),
      });
      return { kind: "text", text: found.skill.body };
    },
  };

  registry.register(def, handler);
}
