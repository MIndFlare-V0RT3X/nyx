// SPDX-License-Identifier: AGPL-3.0-or-later
// The SkillsProvider: per-session catalog resolution over the configured
// dirs (+ the session persona's own skills dir), with per-persona scan
// caching, loaded-per-session tracking (load_skill's already_loaded
// contract), and recency ranking fed by the tool.

import type { Logger, SessionStore, ToolRegistry } from "@nyx/protocol";
import {
  curate,
  filterForSession,
  renderCatalog,
  scanSkills,
  type ScanReport,
} from "./catalog.js";
import type { SkillEntry } from "./skill.js";

export interface SkillsConfig {
  /** Token cap for the catalog section. Default 2000. */
  catalog_max_tokens: number;
  /** Ordered base dirs (`~` expands). The persona's own skills/ dir joins at scan time. */
  dirs: string[];
  /** Always-included skill names. Default empty. */
  pinned: string[];
  /** Never-advertised skill names. Default empty. */
  excluded: string[];
}

export interface SkillsProviderDeps {
  /** Persona root: `<root>/<persona_id>/skills/` is scanned per session. */
  persona_root: string;
  /** The session store — persona/engagement resolution for the hook. */
  store: SessionStore;
  /** The tool registry — capability mapping for a skill's `tools` field. */
  registry: ToolRegistry | undefined;
  logger?: Logger;
  now?: () => number;
}

/** The default skills config (mirrors the config schema defaults). */
export const DEFAULT_SKILLS_CONFIG: SkillsConfig = {
  catalog_max_tokens: 2000,
  dirs: ["~/.nyx/skills"],
  pinned: [],
  excluded: [],
};

/**
 * One per process. The scan is cached per persona (dirs + the persona's own
 * skills dir); the FILTERING and CURATION are per session (persona scope,
 * capabilities, recency, already-loaded tracking).
 */
export class SkillsProvider {
  private readonly cfg: SkillsConfig;
  private readonly deps: SkillsProviderDeps;
  private readonly now: () => number;
  /** persona_id → scan (base dirs + that persona's dir). */
  private readonly scans = new Map<string, ScanReport>();
  /** session_id → loaded skill names (load_skill's already_loaded contract). */
  private readonly loaded = new Map<string, Set<string>>();
  /** skill name → last load timestamp (catalog recency ranking). */
  private readonly lastUsed = new Map<string, number>();

  constructor(config: Partial<SkillsConfig>, deps: SkillsProviderDeps) {
    this.cfg = { ...DEFAULT_SKILLS_CONFIG, ...config };
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** The scan for a persona (cached for the process lifetime — skills dirs
   * are read at startup cadence, like personas themselves). */
  async scanFor(persona_id: string): Promise<ScanReport> {
    const cached = this.scans.get(persona_id);
    if (cached !== undefined) return cached;
    const report = await scanSkills(
      {
        dirs: [...this.cfg.dirs, `${this.deps.persona_root}/${persona_id}/skills`],
        excluded: this.cfg.excluded,
      },
      this.deps.logger,
    );
    this.scans.set(persona_id, report);
    return report;
  }

  /**
   * The catalog section body for a session: scan (per persona) → filter
   * (persona scope + the session's capabilities) → curate (pinned +
   * recency under the token cap) → render.
   */
  async catalogBodyFor(session_id: string, persona_id: string): Promise<string> {
    const report = await this.scanFor(persona_id);
    const sessionSkills = filterForSession(report.skills, {
      persona_id,
      available_capabilities: await this.availableCapabilities(session_id),
      registry: this.deps.registry,
    });
    const { catalog } = curate(
      sessionSkills,
      {
        max_tokens: this.cfg.catalog_max_tokens,
        pinned: this.cfg.pinned,
        last_used: this.lastUsed,
      },
      this.deps.logger,
    );
    return renderCatalog(catalog);
  }

  /**
   * A skill by name for a session, with the scope check the tool reports as
   * scope_mismatch: the skill must be VISIBLE to this session's persona.
   */
  async skillFor(
    session_id: string,
    persona_id: string,
    name: string,
  ): Promise<{ skill: SkillEntry; visible: boolean } | null> {
    const report = await this.scanFor(persona_id);
    const skill = report.skills.find((s) => s.name === name);
    if (skill === null || skill === undefined) return null;
    const visible = filterForSession([skill], {
      persona_id,
      available_capabilities: await this.availableCapabilities(session_id),
      registry: this.deps.registry,
    }).length > 0;
    return { skill, visible };
  }

  /** Session meta (the tool's default persona resolution). */
  async sessionMeta(session_id: string): Promise<Awaited<ReturnType<SessionStore["meta"]>>> {
    return this.deps.store.meta(session_id).catch(() => null);
  }

  /** load_skill bookkeeping: mark loaded + refresh recency. */
  markLoaded(session_id: string, name: string): void {
    let set = this.loaded.get(session_id);
    if (set === undefined) {
      set = new Set();
      this.loaded.set(session_id, set);
    }
    set.add(name);
    this.lastUsed.set(name, this.now());
  }

  /** Has this session already loaded this skill? (already_loaded contract) */
  isLoaded(session_id: string, name: string): boolean {
    return this.loaded.get(session_id)?.has(name) ?? false;
  }

  /** Session teardown hygiene (surface close paths). */
  forgetSession(session_id: string): void {
    this.loaded.delete(session_id);
  }

  /**
   * The session's actually-available capabilities. Phase 4 derives them
   * from real session state: net.egress is available only when an
   * engagement is declared (the tool runtime's scope check denies egress
   * without one — advertising egress-needing skills to a bare session
   * would be a lie).
   */
  private async availableCapabilities(session_id: string): Promise<Set<string>> {
    const caps = new Set<string>();
    const meta = await this.deps.store.meta(session_id).catch(() => null);
    if (meta !== null && meta.engagement !== null) {
      caps.add("net.egress");
    }
    return caps;
  }
}
