// SPDX-License-Identifier: AGPL-3.0-or-later
// The skills catalog: scan → filter → curate → render.
//
//   scan    every <dir>/SKILL.md across the configured dirs, in order; a
//           name seen earlier wins (the operator's dir order IS the priority)
//   filter  persona scope + the session's ACTUAL capabilities: a skill that
//           needs a tool the session's sandbox/policy cannot back (e.g.
//           net.egress without an engagement) is not advertised
//   curate   pinned first, then recently-used, then the rest — until the
//           catalog token cap (default 2000); overflow warns, never fails
//   render  ~50–100 tokens per skill: name, description, when-to-use

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger, ToolRegistry } from "@nyx/protocol";
import { parseSkillMd, type SkillEntry } from "./skill.js";

export interface SkillsScanConfig {
  /** Ordered skill dirs; `~` expands to the home directory. Earlier wins. */
  dirs: string[];
  /** Skill names never advertised (config.skills.excluded). */
  excluded: string[];
}

export interface CatalogOptions {
  /** The catalog token cap (config.skills.catalog_max_tokens, default 2000). */
  max_tokens: number;
  /** Skill names always in the catalog (config.skills.pinned). */
  pinned: string[];
  /** name → last-use timestamp (recency ranks the unpinned tail). */
  last_used?: Map<string, number>;
}

export interface SessionFilter {
  /** The session's persona — a scoped skill only ships to its personas. */
  persona_id: string;
  /**
   * The session's actually-available capabilities (e.g. "net.egress" only
   * when the engagement + scope back it). A skill whose named tools need a
   * capability the session lacks is filtered out — advertising work the
   * session cannot do would be a prompt-injection-grade lie.
   */
  available_capabilities: Set<string>;
  /** The tool registry — maps a skill's `tools` names to their capabilities. */
  registry: ToolRegistry | undefined;
}

export interface ScanReport {
  skills: SkillEntry[];
  warnings: string[];
}

/** Expand `~` and make absolute. */
export function expandDir(dir: string): string {
  const expanded = dir.startsWith("~/") || dir === "~"
    ? path.join(os.homedir(), dir.slice(1))
    : dir;
  return path.resolve(expanded);
}

/** Scan the configured dirs. Malformed entries warn and are skipped. */
export async function scanSkills(config: SkillsScanConfig, logger?: Logger): Promise<ScanReport> {
  const byName = new Map<string, SkillEntry>();
  const warnings: string[] = [];
  const excluded = new Set(config.excluded);

  for (const dir of config.dirs) {
    const root = expandDir(dir);
    let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }> = [];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // absent dir = no skills there
      warnings.push(`skills dir ${root} unreadable: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    // Deterministic order within a dir: name sort.
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      // Flat layout: a bare SKILL.md directly in the dir. Package layout:
      // <dir>/<name>/SKILL.md in a subdirectory. Anything else is not a skill.
      const candidate =
        entry.isFile() && entry.name === "SKILL.md"
          ? path.join(root, entry.name)
          : entry.isDirectory()
            ? path.join(root, entry.name, "SKILL.md")
            : null;
      if (candidate === null) continue;
      let text: string;
      try {
        text = await fsp.readFile(candidate, "utf8");
      } catch {
        continue; // not a skill (no SKILL.md here)
      }
      const parsed = parseSkillMd(text, candidate);
      if (!parsed.ok) {
        warnings.push(`${candidate}: ${parsed.warning} — skipped`);
        continue;
      }
      if (excluded.has(parsed.skill.name)) continue;
      if (byName.has(parsed.skill.name)) {
        warnings.push(
          `${candidate}: skill "${parsed.skill.name}" already defined earlier in the dir order — skipped`,
        );
        continue;
      }
      byName.set(parsed.skill.name, parsed.skill);
    }
  }

  for (const warning of warnings) {
    logger?.warn("skills.scan_warning", { warning });
  }
  return { skills: [...byName.values()], warnings };
}

/**
 * The capabilities a skill's named tools require (via the registry's tool
 * definitions). A tool name that does not exist grants nothing and costs
 * nothing — Phase 4's `tools` field is informational.
 */
export function requiredCapabilities(skill: SkillEntry, registry: ToolRegistry | undefined): Set<string> {
  const caps = new Set<string>();
  if (skill.tools === undefined || registry === undefined) return caps;
  for (const name of skill.tools) {
    const found = registry.get(name);
    if (found !== null) for (const c of found.def.capabilities) caps.add(c);
  }
  return caps;
}

/** Filter the scan to what THIS session may see. */
export function filterForSession(
  skills: readonly SkillEntry[],
  session: SessionFilter,
): SkillEntry[] {
  return skills.filter((skill) => {
    if (skill.persona_scope !== undefined && !skill.persona_scope.includes(session.persona_id)) {
      return false;
    }
    const needed = requiredCapabilities(skill, session.registry);
    for (const cap of needed) {
      if (!session.available_capabilities.has(cap)) return false;
    }
    return true;
  });
}

/** Rough token estimate: ~4 chars per token, rounded up per line. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** One catalog line per skill — the ~50–100 token advertisement. */
export function catalogLine(skill: SkillEntry): string {
  const trigger = skill.when_to_use !== undefined ? ` — trigger: ${skill.when_to_use}` : "";
  const tools =
    skill.tools !== undefined && skill.tools.length > 0 ? ` [tools: ${skill.tools.join(", ")}]` : "";
  return `- ${skill.name}${skill.version !== undefined ? ` (v${skill.version})` : ""}: ${skill.description}${trigger}${tools}`;
}

/**
 * Curate to the token cap: pinned first (in the configured pin order), then
 * by recency of use, then alphabetical — the catalog is a ranked list, and
 * the cap is what keeps progressive disclosure progressive. Overflow warns
 * (the dropped names are listed), never fails.
 */
export function curate(
  skills: readonly SkillEntry[],
  opts: CatalogOptions,
  logger?: Logger,
): { catalog: SkillEntry[]; overflow: string[] } {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const pinned = opts.pinned.map((p) => byName.get(p)).filter((s): s is SkillEntry => s !== undefined);
  const pinnedSet = new Set(pinned.map((s) => s.name));
  const lastUsed = opts.last_used ?? new Map<string, number>();
  const rest = skills
    .filter((s) => !pinnedSet.has(s.name))
    .sort((a, b) => {
      const la = lastUsed.get(a.name) ?? 0;
      const lb = lastUsed.get(b.name) ?? 0;
      if (la !== lb) return lb - la; // most recently used first
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; // then name
    });

  const header = "Available skills (load one with the load_skill tool):";
  const budget = opts.max_tokens - estimateTokens(header) - estimateTokens("No skills installed.");
  const catalog: SkillEntry[] = [];
  let used = 0;
  const overflow: string[] = [];
  for (const skill of [...pinned, ...rest]) {
    const cost = estimateTokens(catalogLine(skill));
    if (catalog.length > 0 && used + cost > Math.max(0, budget)) {
      overflow.push(skill.name);
      continue;
    }
    catalog.push(skill);
    used += cost;
  }
  if (overflow.length > 0) {
    // Overflow warns, never fails: pinned skills and recent uses are kept,
    // the tail is dropped and the drop is named.
    logger?.warn("skills.catalog_overflow", {
      dropped: overflow,
      kept_tokens: used,
      max_tokens: opts.max_tokens,
    });
  }
  return { catalog, overflow };
}

/** The rendered section body for the given (already curated) skills. */
export function renderCatalog(skills: readonly SkillEntry[]): string {
  if (skills.length === 0) return "No skills installed.";
  return ["Available skills (load one with the load_skill tool):", ...skills.map(catalogLine)].join("\n");
}
