// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 4 §4.4 acceptance: the SKILL.md parser, the catalog pipeline
// (scan/dedupe/exclude → persona-scope + capability filtering → token-cap
// curation with pinned + recency), the load_skill tool contracts, and the
// golden-file prompt test — the catalog section exactly as the model sees
// it, injected through the real context.initialize hook flow.

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createKernel } from "@nyx/kernel";
import { openSessionStore } from "@nyx/session";
import type {
  InitContext,
  PromptSection,
  SessionStore,
  ToolContext,
  ToolDefinition,
  ToolHandler,
  ToolRegistry,
} from "@nyx/protocol";
import { SECTION_ORDER } from "@nyx/protocol";
import {
  LOAD_SKILL_TOOL,
  SkillsProvider,
  catalogLine,
  curate,
  estimateTokens,
  parseSkillMd,
  registerLoadSkillTool,
  registerSkillsHook,
} from "./index.js";

const stacks: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  while (stacks.length > 0) await stacks.pop()!();
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  stacks.push(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeSkill(
  dir: string,
  name: string,
  frontmatter: string,
  body = "Do the thing carefully.\n",
): Promise<void> {
  await fsp.mkdir(path.join(dir, name), { recursive: true });
  await fsp.writeFile(
    path.join(dir, name, "SKILL.md"),
    `---\n${frontmatter}\n---\n\n${body}`,
    "utf8",
  );
}

/** A minimal typed registry; `known` maps tool names → capabilities for the
 * catalog filter (the parent registry the skills' `tools` names resolve against). */
class FakeRegistry implements ToolRegistry {
  readonly entries = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();
  constructor(
    private readonly known: Array<{ name: string; capabilities: Array<"net.egress"> }> = [],
  ) {}
  register(def: ToolDefinition, handler: ToolHandler): void {
    this.entries.set(def.name, { def, handler });
  }
  unregister(name: string): void {
    this.entries.delete(name);
  }
  list(): ToolDefinition[] {
    return [...this.entries.values()].map((e) => e.def);
  }
  get(name: string): { def: ToolDefinition; handler: ToolHandler } | null {
    const registered = this.entries.get(name);
    if (registered !== undefined) return registered;
    const k = this.known.find((t) => t.name === name);
    if (k === undefined) return null;
    return {
      def: {
        name: k.name,
        description: `known tool ${k.name}`,
        input_schema: { type: "object" },
        risk: "R0",
        capabilities: k.capabilities,
        handler: `builtin:${k.name}`,
      },
      handler: null as never,
    };
  }
}

describe("SKILL.md parsing", () => {
  it("parses a full frontmatter + body", () => {
    const r = parseSkillMd(
      `---\nname: deploy-runbook\ndescription: Step-by-step deploy procedure for the prod cluster.\nwhen_to_use: deploying to production\nversion: 1.2.0\ntools: [shell.exec, web.fetch]\npersona_scope: [sre, default]\n---\n\n1. Freeze the queue\n2. Deploy\n`,
      "/x/deploy-runbook/SKILL.md",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.name).toBe("deploy-runbook");
      expect(r.skill.version).toBe("1.2.0");
      expect(r.skill.tools).toEqual(["shell.exec", "web.fetch"]);
      expect(r.skill.persona_scope).toEqual(["sre", "default"]);
      expect(r.skill.body).toBe("1. Freeze the queue\n2. Deploy");
    }
  });

  it("malformed entries are warning-shaped refusals, never throws", () => {
    const cases = [
      "no frontmatter at all",
      "---\nname: x\n", // unterminated
      "---\nname: [broken\n---\n\nbody\n", // bad YAML
      "---\nname: Bad-Name\ndescription: too short\n---\n\nbody\n", // schema
      "---\nname: ok-name\ndescription: a valid description here\n---\n\n   \n", // empty body
    ];
    for (const text of cases) {
      const r = parseSkillMd(text, "/x/SKILL.md");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.warning.length).toBeGreaterThan(0);
    }
  });
});

describe("catalog pipeline", () => {
  it("scans dirs in order, dedupes by name, skips excluded, warns on malformed", async () => {
    const dirA = await tmpDir("nyx-skills-a-");
    const dirB = await tmpDir("nyx-skills-b-");
    await writeSkill(dirA, "alpha", "name: alpha\ndescription: The alpha skill for testing.");
    await writeSkill(dirA, "dupe", "name: dupe\ndescription: First definition of dupe wins.");
    await writeSkill(dirB, "dupe", "name: dupe\ndescription: Second definition must lose.");
    await writeSkill(dirB, "beta", "name: beta\ndescription: The beta skill also for testing.");
    await writeSkill(dirB, "legacy", "name: legacy\ndescription: Excluded by config, never seen.");
    // Flat layout: a bare SKILL.md directly in the dir.
    await fsp.writeFile(
      path.join(dirA, "SKILL.md"),
      "---\nname: flat\ndescription: A flat-layout skill sitting right in the dir.\n---\n\nflat body\n",
      "utf8",
    );
    // Malformed: skipped with a warning.
    await writeSkill(dirB, "broken", "name: [");

    const provider = new SkillsProvider(
      { dirs: [dirA, dirB], excluded: ["legacy"] },
      { persona_root: "/nonexistent", store: null as never, registry: undefined },
    );
    const scan = await provider.scanFor("default");
    expect(scan.skills.map((s) => s.name).sort()).toEqual(["alpha", "beta", "dupe", "flat"]);
    expect(scan.skills.find((s) => s.name === "dupe")!.description).toContain("First definition");
    expect(scan.warnings.some((w) => w.includes("broken") && w.includes("skipped"))).toBe(true);
  });

  it("filters by persona scope and by the session's real capabilities", async () => {
    const dir = await tmpDir("nyx-skills-filter-");
    await writeSkill(dir, "scoped", "name: scoped\ndescription: Only for the sre persona.\npersona_scope: [sre]");
    await writeSkill(dir, "open", "name: open\ndescription: Every persona may use this one.");
    await writeSkill(dir, "webby", "name: webby\ndescription: Needs network egress to work at all.\ntools: [web.fetch]");
    const registry = new FakeRegistry([{ name: "web.fetch", capabilities: ["net.egress"] as Array<"net.egress"> }]);

    const provider = new SkillsProvider(
      { dirs: [dir] },
      { persona_root: "/nonexistent", store: null as never, registry: registry as never },
    );
    const scan = await provider.scanFor("default");

    // Persona "default": scoped filtered out; webby needs net.egress.
    const noEgress = await import("./index.js").then((m) =>
      m.filterForSession(scan.skills, {
        persona_id: "default",
        available_capabilities: new Set(),
        registry,
      }),
    );
    expect(noEgress.map((s) => s.name)).toEqual(["open"]);

    const withEgress = await import("./index.js").then((m) =>
      m.filterForSession(scan.skills, {
        persona_id: "default",
        available_capabilities: new Set(["net.egress"]),
        registry,
      }),
    );
    expect(withEgress.map((s) => s.name).sort()).toEqual(["open", "webby"]);

    const sre = await import("./index.js").then((m) =>
      m.filterForSession(scan.skills, {
        persona_id: "sre",
        available_capabilities: new Set(),
        registry,
      }),
    );
    expect(sre.map((s) => s.name).sort()).toEqual(["open", "scoped"]);
  });

  it("curates under the token cap: pinned first, recency next, overflow reported", () => {
    const skills = Array.from({ length: 40 }, (_, i) => ({
      name: `skill-${String(i).padStart(2, "0")}`,
      description: `Skill number ${i} with a description of reasonable length.`,
      body: "body",
      file: `/x/skill-${i}/SKILL.md`,
    }));
    // Pin one, use another recently.
    const lastUsed = new Map([["skill-25", 999]]);
    const { catalog, overflow } = curate(skills, {
      max_tokens: 400,
      pinned: ["skill-07"],
      last_used: lastUsed,
    });
    expect(catalog.length).toBeLessThan(skills.length);
    expect(overflow.length).toBeGreaterThan(0);
    // Pinned first, most-recently-used second.
    expect(catalog[0]!.name).toBe("skill-07");
    expect(catalog[1]!.name).toBe("skill-25");
    // Everything kept fits the cap.
    const rendered = catalog.map(catalogLine).join("\n");
    expect(estimateTokens(rendered)).toBeLessThanOrEqual(400);
  });
});

describe("load_skill tool contracts", () => {
  async function setup(opts: { persona?: string; engagement?: boolean } = {}) {
    const dir = await tmpDir("nyx-skills-tool-");
    await writeSkill(dir, "alpha", "name: alpha\ndescription: The alpha skill for testing.", "ALPHA BODY\n");
    await writeSkill(
      dir,
      "sre-only",
      "name: sre-only\ndescription: Scoped to sre.\npersona_scope: [sre]",
      "SRE BODY\n",
    );
    const store: SessionStore = openSessionStore(":memory:");
    stacks.push(() => store.close());
    const personaRoot = await tmpDir("nyx-skills-persona-");
    const session = await store.create({
      owner_id: "o",
      persona_id: opts.persona ?? "default",
      ...(opts.engagement
        ? { engagement: { target: "example.com", allow: { cidrs: ["0.0.0.0/0"] } } as never }
        : {}),
    });
    const provider = new SkillsProvider(
      { dirs: [dir] },
      { persona_root: personaRoot, store, registry: undefined },
    );
    const registry = new FakeRegistry();
    registerLoadSkillTool(registry, { provider });
    const tool = registry.get(LOAD_SKILL_TOOL)!;
    const events: Array<{ type: string; name?: string }> = [];
    const ctx = {
      session_id: session.session_id,
      turn_id: "t1",
      call_id: "c1",
      emit: (e: { type: string; name?: string }) => events.push(e),
    } as unknown as ToolContext;
    return { provider, tool, ctx, events, session };
  }

  it("loads a visible skill: body as text + skill.loaded on the log", async () => {
    const { tool, ctx, events } = await setup();
    const out = await tool.handler.execute(
      { call_id: "c1", name: LOAD_SKILL_TOOL, input: { name: "alpha" } } as never,
      ctx,
    );
    expect(out).toEqual({ kind: "text", text: "ALPHA BODY" });
    expect(events).toEqual([
      { type: "skill.loaded", session_id: ctx.session_id, name: "alpha", version: null, ts: expect.any(Number) },
    ]);
  });

  it("re-load in the same session → already_loaded; unknown → not_found", async () => {
    const { tool, ctx, events } = await setup();
    await tool.handler.execute(
      { call_id: "c1", name: LOAD_SKILL_TOOL, input: { name: "alpha" } } as never,
      ctx,
    );
    await expect(
      tool.handler.execute({ call_id: "c2", name: LOAD_SKILL_TOOL, input: { name: "alpha" } } as never, ctx),
    ).rejects.toMatchObject({ code: "already_loaded" });
    await expect(
      tool.handler.execute({ call_id: "c3", name: LOAD_SKILL_TOOL, input: { name: "nope" } } as never, ctx),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(events).toHaveLength(1); // only the first load
  });

  it("a persona-scope mismatch → scope_mismatch (the skill EXISTS but is not for us)", async () => {
    const { tool, ctx } = await setup();
    await expect(
      tool.handler.execute({ call_id: "c1", name: LOAD_SKILL_TOOL, input: { name: "sre-only" } } as never, ctx),
    ).rejects.toMatchObject({ code: "scope_mismatch" });
  });

  it("the tool is R0 with no capabilities — loading grants nothing", async () => {
    const dir = await tmpDir("nyx-skills-def-");
    const store: SessionStore = openSessionStore(":memory:");
    stacks.push(() => store.close());
    const provider = new SkillsProvider(
      { dirs: [dir] },
      { persona_root: "/nonexistent", store, registry: undefined },
    );
    const registry = new FakeRegistry();
    registerLoadSkillTool(registry, { provider });
    expect(registry.get(LOAD_SKILL_TOOL)!.def).toMatchObject({
      name: LOAD_SKILL_TOOL,
      risk: "R0",
      capabilities: [],
    });
  });
});

describe("golden-file prompt test (§5 acceptance)", () => {
  it("the context.initialize hook injects the curated catalog exactly as golden", async () => {
    const golden = await fsp.readFile(
      path.join(import.meta.dirname, "__golden__", "system-prompt.txt"),
      "utf8",
    );

    const skillsDir = await tmpDir("nyx-skills-golden-");
    await writeSkill(skillsDir, "deploy", "name: deploy\ndescription: Production deploy runbook steps.\nwhen_to_use: deploying to prod\nversion: 1.0.0\ntools: [shell.exec]", "DEPLOY BODY");
    await writeSkill(skillsDir, "review", "name: review\ndescription: Code review checklist for this repo.", "REVIEW BODY");
    await writeSkill(
      skillsDir,
      "sre-only",
      "name: sre-only\ndescription: Scoped away from the default persona.\npersona_scope: [sre]",
      "SRE BODY",
    );

    const store: SessionStore = openSessionStore(":memory:");
    stacks.push(() => store.close());
    const session = await store.create({ owner_id: "o", persona_id: "default" });

    const provider = new SkillsProvider(
      { dirs: [skillsDir], catalog_max_tokens: 2000, pinned: [], excluded: [] },
      { persona_root: "/nonexistent-personas", store, registry: undefined },
    );
    const kernel = createKernel();
    const unregister = registerSkillsHook(kernel, { provider });
    stacks.push(unregister);

    // The persona's own assembly (an empty skills catalog — what the loop
    // builds BEFORE the hooks run), in the fixed section order.
    const sections: PromptSection[] = SECTION_ORDER.map((id) => ({
      id,
      title: id,
      body: id === "SKILLS_CATALOG" ? "No skills installed." : `${id} body.`,
    }));
    const initCtx: InitContext = {
      session_id: session.session_id,
      turn_id: "golden-t1",
      sections,
      messages: [],
      facts: {},
    };
    // The loop's exact merge: every non-void partial, in result order.
    for (const partial of await kernel.hooks.emit("context.initialize", initCtx)) {
      if (partial === undefined || partial === null) continue;
      Object.assign(initCtx, partial);
    }

    const assembled = initCtx.sections.map((s) => `## ${s.title}\n${s.body}`).join("\n\n");
    expect(assembled).toBe(golden.trim());
  });
});
