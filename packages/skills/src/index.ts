// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/skills — the Phase 4 progressive-disclosure skill system.
//
// A skill is a SKILL.md (YAML frontmatter + Markdown body) in one of the
// configured dirs or the persona's own skills/ dir. The frontmatter rides
// in the system prompt's SKILLS_CATALOG section (curated under a token
// cap, scoped to the persona and the session's real capabilities); the
// body loads on demand through the R0 load_skill tool — skills are trusted
// CONTENT, not tools: loading grants nothing. Every load lands on the
// session log as skill.loaded.
//
// A skill's frontmatter `tools` field is INFORMATIONAL in Phase 4: parsed,
// validated, surfaced in the catalog, and used to filter the catalog by
// the session's capabilities — runtime tool GATING is the Phase 5 security
// subsystem's job.

export {
  SkillFrontmatterSchema,
  parseSkillMd,
  type SkillEntry,
  type ParseResult,
} from "./skill.js";
export {
  catalogLine,
  curate,
  estimateTokens,
  expandDir,
  filterForSession,
  renderCatalog,
  requiredCapabilities,
  scanSkills,
  type CatalogOptions,
  type ScanReport,
  type SessionFilter,
  type SkillsScanConfig,
} from "./catalog.js";
export {
  DEFAULT_SKILLS_CONFIG,
  SkillsProvider,
  type SkillsConfig,
  type SkillsProviderDeps,
} from "./provider.js";
export {
  LOAD_SKILL_INPUT_SCHEMA,
  LOAD_SKILL_TOOL,
  registerLoadSkillTool,
  type LoadSkillInput,
  type RegisterLoadSkillDeps,
} from "./tool.js";
export { registerSkillsHook, type RegisterSkillsHookDeps } from "./hook.js";
