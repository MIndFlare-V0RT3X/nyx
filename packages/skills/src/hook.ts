// SPDX-License-Identifier: AGPL-3.0-or-later
// The context.initialize hook (Phase 4 §4.4): injects the skills catalog
// into the assembled system prompt's SKILLS_CATALOG section, per session.
//
// The agent loop builds the persona's sections FIRST (with an empty
// skills_catalog — "No skills installed."), then runs the context.
// initialize hooks; a hook returning { sections } replaces the array. This
// hook rewrites exactly one section: SKILLS_CATALOG gets the curated
// catalog body for THIS session (persona scope, capabilities, recency,
// token cap). Everything else passes through untouched — the golden-tested
// section order is preserved.

import type { InitContext, Kernel, PromptSection } from "@nyx/protocol";
import type { SkillsProvider } from "./provider.js";

export interface RegisterSkillsHookDeps {
  provider: SkillsProvider;
}

/**
 * Register the catalog-injection hook on the kernel. Returns the unregister
 * function (surfaces' close paths).
 */
export function registerSkillsHook(kernel: Kernel, deps: RegisterSkillsHookDeps): () => void {
  const handler = async (initCtx: InitContext): Promise<Partial<InitContext> | void> => {
    const meta = await deps.provider.sessionMeta(initCtx.session_id).catch(() => null);
    const persona_id = meta?.persona_id ?? "default";
    let body: string;
    try {
      body = await deps.provider.catalogBodyFor(initCtx.session_id, persona_id);
    } catch {
      // A failed scan must never break the turn — the section degrades to
      // the honest empty catalog, loudly logged upstream.
      body = "No skills installed.";
    }
    const sections: PromptSection[] = initCtx.sections.map((section) =>
      section.id === "SKILLS_CATALOG" ? { ...section, body } : section,
    );
    return { sections };
  };

  return kernel.hooks.on("context.initialize", handler);
}
