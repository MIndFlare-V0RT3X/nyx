// SPDX-License-Identifier: AGPL-3.0-or-later
// Persona runtime contract: deterministic assembly of the system prompt from
// a persona directory, in a fixed section order.

import type { PromptSection, SectionId } from "./util.js";
import type { RiskTier } from "./tools.js";

export interface PromptAssemblyInput {
  /** Workspace facts: cwd, date, sandbox id, engagement summary, git status, ... */
  session_facts: Record<string, unknown>;
  /** One entry per memory file (progressive disclosure: titles only). */
  memory_catalog: Array<{ id: string; title: string; path: string }>;
  skills_catalog: Array<{ name: string; description: string; trigger?: string }>;
  tools_catalog: Array<{ name: string; risk: RiskTier; description: string }>;
}

export interface PersonaRuntime {
  readonly persona_id: string;
  /** Assembles the system prompt sections in the fixed order given by SectionId. */
  buildSystemPrompt(input: PromptAssemblyInput): PromptSection[];
}

/** The fixed assembly order — golden-tested, not configurable. */
export const SECTION_ORDER: SectionId[] = [
  "BASE_PREAMBLE",
  "CONTRACT",
  "SOUL",
  "USER",
  "MEMORY_CATALOG",
  "SKILLS_CATALOG",
  "TOOLS_CATALOG",
  "SESSION_CONTEXT",
];
