// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { SECTION_ORDER } from "@nyx/protocol";
import type { PromptAssemblyInput } from "@nyx/protocol";
import {
  BASE_PREAMBLE,
  PersonaRuntimeImpl,
  assemblePromptText,
  loadPersona,
} from "./index.js";

const realPersonasRoot = fileURLToPath(new URL("../../../personas", import.meta.url));
const altFixtureRoot = fileURLToPath(new URL("../fixtures", import.meta.url));
const goldenPath = fileURLToPath(new URL("./fixtures/golden-prompt.txt", import.meta.url));

const FIXED_INPUT: PromptAssemblyInput = {
  session_facts: {
    sandbox_id: "sbx1",
    date: "2026-11-04",
    cwd: "/w",
    engagement: {
      id: "ENG-9",
      operator_id: "owner",
      authorized_at: 1700000000000,
      expires_at: 1900000000000,
      targets: {
        cidrs: ["10.0.0.0/8"],
        domains: ["example.com"],
      },
    },
  },
  memory_catalog: [
    { id: "m1", title: "db-maintenance.md notes", path: "memories/persona/db-maintenance.md" },
    { id: "m2", title: "vpn topology sketch", path: "memories/owner/vpn-topology.md" },
  ],
  skills_catalog: [
    { name: "recon-notes", description: "Summarize recon output into scoped findings.", trigger: "after a recon scan completes" },
  ],
  tools_catalog: [
    { name: "fs.read", risk: "R0", description: "Read a file from the sandbox workspace." },
    { name: "web.fetch", risk: "R2", description: "Fetch a URL inside the engagement scope." },
  ],
};

async function defaultRuntime(): Promise<PersonaRuntimeImpl> {
  return new PersonaRuntimeImpl(await loadPersona(realPersonasRoot, "default"));
}

describe("buildSystemPrompt", () => {
  it("produces exactly 8 sections with ids in protocol SECTION_ORDER and fixed titles", async () => {
    const runtime = await defaultRuntime();
    const sections = runtime.buildSystemPrompt(FIXED_INPUT);
    expect(sections.length).toBe(8);
    expect(sections.map((s) => s.id)).toEqual(SECTION_ORDER);
    expect(sections.map((s) => s.title)).toEqual([
      "Harness",
      "Contract",
      "Soul",
      "Operator Profile",
      "Memory",
      "Skills",
      "Tools",
      "Session Context",
    ]);
    for (const section of sections) {
      expect(typeof section.body).toBe("string");
      expect(section.body.length).toBeGreaterThan(0);
    }
    expect(runtime.persona_id).toBe("default");
  });

  it("BASE_PREAMBLE is the harness block and carries the required rules", async () => {
    const lines = BASE_PREAMBLE.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(40);
    expect(lines.length).toBeLessThanOrEqual(60);
    expect(BASE_PREAMBLE).toContain("NYX");
    expect(BASE_PREAMBLE).toContain("mission");
    expect(BASE_PREAMBLE).toContain("outranks style defaults and canned response patterns");
    expect(BASE_PREAMBLE).toContain('<tool_output trust="untrusted">');
    expect(BASE_PREAMBLE).toContain("fs.read");
    expect(BASE_PREAMBLE).toContain("SESSION_CONTEXT");
    expect(BASE_PREAMBLE).toContain("never dress a guess as a result");
    // no markdown headers inside the preamble body
    expect(lines.some((l) => l.startsWith("#"))).toBe(false);
    const runtime = await defaultRuntime();
    expect(runtime.buildSystemPrompt(FIXED_INPUT)[0]).toEqual({
      id: "BASE_PREAMBLE",
      title: "Harness",
      body: BASE_PREAMBLE,
    });
  });

  it("CONTRACT section carries the operator-binding line and the file verbatim", async () => {
    const runtime = await defaultRuntime();
    const contractSection = runtime.buildSystemPrompt(FIXED_INPUT)[1]!;
    const contractFile = fs.readFileSync(`${realPersonasRoot}/default/CONTRACT.md`, "utf8");
    expect(contractSection.body).toContain(
      "The following is the operator binding. It is a binding directive.",
    );
    // file content verbatim (bar trailing blank padding, which the assembler trims)
    expect(contractSection.body).toContain(contractFile.replace(/\s+$/, ""));
  });

  it("renders memory, skills and tools catalog lines with risk markers", async () => {
    const runtime = await defaultRuntime();
    const sections = runtime.buildSystemPrompt(FIXED_INPUT);
    const byId = new Map(sections.map((s) => [s.id, s.body]));
    expect(byId.get("MEMORY_CATALOG")).toBe(
      [
        "- db-maintenance.md notes (memories/persona/db-maintenance.md)",
        "- vpn topology sketch (memories/owner/vpn-topology.md)",
      ].join("\n"),
    );
    expect(byId.get("SKILLS_CATALOG")).toBe(
      "- recon-notes: Summarize recon output into scoped findings. — trigger: after a recon scan completes",
    );
    expect(byId.get("TOOLS_CATALOG")).toBe(
      [
        "- fs.read [risk R0] — Read a file from the sandbox workspace.",
        "- web.fetch [risk R2] — Fetch a URL inside the engagement scope.",
      ].join("\n"),
    );
  });

  it("renders session facts alphabetically with the engagement block last", async () => {
    const runtime = await defaultRuntime();
    const body = runtime.buildSystemPrompt(FIXED_INPUT)[7]!.body;
    const lines = body.split("\n");
    expect(lines).toEqual([
      "- cwd: /w",
      "- date: 2026-11-04",
      "- sandbox_id: sbx1",
      "- engagement: ENG-9 (authorized by owner, expires 2030-03-17T17:46:40.000Z)",
      '- engagement targets: cidrs=["10.0.0.0/8"] domains=["example.com"]',
      "- engagement scope is enforced by the harness; out-of-scope network actions are denied",
    ]);
  });

  it("empty catalogs render their placeholder lines", async () => {
    const runtime = await defaultRuntime();
    const sections = runtime.buildSystemPrompt({
      session_facts: {},
      memory_catalog: [],
      skills_catalog: [],
      tools_catalog: [],
    });
    const byId = new Map(sections.map((s) => [s.id, s.body]));
    expect(byId.get("MEMORY_CATALOG")).toBe("No memories indexed yet.");
    expect(byId.get("SKILLS_CATALOG")).toBe("No skills installed.");
    expect(byId.get("TOOLS_CATALOG")).toBe("No tools installed.");
    expect(byId.get("SESSION_CONTEXT")).toBe("");
  });

  it("deterministic: identical input produces byte-identical output", async () => {
    const runtime = await defaultRuntime();
    const first = assemblePromptText(runtime.buildSystemPrompt(FIXED_INPUT));
    const second = assemblePromptText(runtime.buildSystemPrompt(FIXED_INPUT));
    expect(first).toBe(second);
    expect(JSON.stringify(runtime.buildSystemPrompt(FIXED_INPUT))).toBe(
      JSON.stringify(runtime.buildSystemPrompt(FIXED_INPUT)),
    );
  });

  it("golden: assembled text matches the committed snapshot", async () => {
    const runtime = await defaultRuntime();
    const text = assemblePromptText(runtime.buildSystemPrompt(FIXED_INPUT));
    await expect(text).toMatchFileSnapshot(goldenPath);
  });
});

describe("persona swap", () => {
  it("a different persona changes CONTRACT but not section count or order", async () => {
    const alt = new PersonaRuntimeImpl(await loadPersona(altFixtureRoot, "alt"));
    const base = await defaultRuntime();

    expect(alt.persona_id).toBe("alt");
    const altSections = alt.buildSystemPrompt(FIXED_INPUT);
    const baseSections = base.buildSystemPrompt(FIXED_INPUT);

    expect(altSections.length).toBe(8);
    expect(altSections.map((s) => s.id)).toEqual(SECTION_ORDER);
    expect(altSections.map((s) => s.title)).toEqual(baseSections.map((s) => s.title));

    const altContract = altSections[1]!.body;
    const baseContract = baseSections[1]!.body;
    expect(altContract).not.toBe(baseContract);
    expect(altContract).toContain("# CONTRACT — ALT FIXTURE");
    expect(altContract).toContain("The following is the operator binding. It is a binding directive.");
    expect(baseContract).toContain("# CONTRACT");

    // catalogs/session facts are persona-independent
    expect(altSections[4]!.body).toBe(baseSections[4]!.body);
    expect(altSections[6]!.body).toBe(baseSections[6]!.body);
    expect(altSections[7]!.body).toBe(baseSections[7]!.body);
  });
});

describe("assemblePromptText", () => {
  it("renders titled blocks separated by one blank line", async () => {
    const runtime = await defaultRuntime();
    const text = assemblePromptText(runtime.buildSystemPrompt(FIXED_INPUT));
    expect(text.startsWith("## Harness\n")).toBe(true);
    expect(text).toContain("\n\n## Contract\n");
    expect(text).toContain("\n\n## Soul\n");
    expect(text).toContain("\n\n## Operator Profile\n");
    expect(text).toContain("\n\n## Memory\n");
    expect(text).toContain("\n\n## Skills\n");
    expect(text).toContain("\n\n## Tools\n");
    expect(text).toContain("\n\n## Session Context\n");
    expect(text.endsWith("- engagement scope is enforced by the harness; out-of-scope network actions are denied")).toBe(true);
    expect(text).not.toMatch(/\n\n\n/);
  });
});
