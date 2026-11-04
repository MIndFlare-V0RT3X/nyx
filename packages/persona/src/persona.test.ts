// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PersonaLoadError, PersonaSchema, loadPersona } from "./index.js";

const realPersonasRoot = fileURLToPath(new URL("../../../personas", import.meta.url));

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpPersonaDir(files: Record<string, string>): { root: string; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-persona-test-"));
  tmpDirs.push(root);
  const dir = path.join(root, "partial");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return { root, dir };
}

const VALID_YAML = [
  "schema: 1",
  "id: partial",
  "name: Partial",
  "voice:",
  "  register: peer",
  "  verbosity: normal",
  "cognition:",
  "  planning: auto",
  "contract:",
  "  honesty:",
  "    never_fabricate: true",
  "  scope:",
  "    enforce_engagement: true",
  "  escalate: []",
  "  always: []",
  "capabilities:",
  "  domains: []",
  "  tools_allow: []",
  "  tools_deny: []",
  "memory:",
  "  scopes: []",
].join("\n");

describe("loadPersona", () => {
  it("loads the real repo default persona with all five files", async () => {
    const loaded = await loadPersona(realPersonasRoot, "default");
    expect(loaded.config.id).toBe("default");
    expect(loaded.config.name).toBe("Nyx");
    expect(loaded.config.schema).toBe(1);
    expect(loaded.config.voice.register).toBe("close");
    expect(loaded.config.voice.verbosity).toBe("terse");
    expect(loaded.config.cognition.planning).toBe("auto");
    expect(loaded.config.contract.honesty).toMatchObject({
      never_fabricate: true,
      evidence_required: true,
      no_completion_without_verification: true,
    });
    expect(loaded.config.contract.scope).toMatchObject({
      enforce_engagement: true,
      deny_out_of_scope: true,
      one_line_reason: true,
    });
    expect(loaded.config.contract.escalate).toContain("irreversible");
    expect(loaded.config.capabilities.tools_allow).toEqual(["*"]);
    expect(loaded.config.memory.scopes).toEqual(["session", "persona", "owner"]);
    expect(loaded.soul_md.length).toBeGreaterThan(0);
    expect(loaded.contract_md.length).toBeGreaterThan(0);
    expect(loaded.user_md.length).toBeGreaterThan(0);
    expect(loaded.memory_md.length).toBeGreaterThan(0);
    expect(loaded.contract_md).toContain("# CONTRACT");
  });

  it("missing file throws validation_failed naming the missing file path", async () => {
    const { root } = tmpPersonaDir({
      "persona.yaml": VALID_YAML,
      "SOUL.md": "# SOUL\nfixture soul\n",
      // CONTRACT.md, USER.md, MEMORY.md missing
    });
    try {
      await loadPersona(root, "partial");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PersonaLoadError);
      const e = err as PersonaLoadError;
      expect(e.code).toBe("validation_failed");
      expect(e.message).toContain(path.join(root, "partial", "CONTRACT.md"));
    }
  });

  it("nonexistent persona directory throws validation_failed naming the missing path", async () => {
    try {
      await loadPersona(realPersonasRoot, "does-not-exist");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PersonaLoadError);
      const e = err as PersonaLoadError;
      expect(e.code).toBe("validation_failed");
      expect(e.message).toContain(path.join(realPersonasRoot, "does-not-exist", "persona.yaml"));
    }
  });

  it("invalid enum throws with the field path in the message", async () => {
    const { root } = tmpPersonaDir({
      "persona.yaml": VALID_YAML.replace("register: peer", "register: warm"),
      "SOUL.md": "s",
      "CONTRACT.md": "c",
      "USER.md": "u",
      "MEMORY.md": "m",
    });
    try {
      await loadPersona(root, "partial");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PersonaLoadError);
      const e = err as PersonaLoadError;
      expect(e.code).toBe("validation_failed");
      expect(e.message).toContain("voice.register");
      expect(e.message).toContain("persona.yaml");
    }
  });

  it("missing required field throws with the field path", async () => {
    const { root } = tmpPersonaDir({
      "persona.yaml": VALID_YAML.replace("  planning: auto", "  self_check: true"),
      "SOUL.md": "s",
      "CONTRACT.md": "c",
      "USER.md": "u",
      "MEMORY.md": "m",
    });
    await expect(loadPersona(root, "partial")).rejects.toThrowError(/cognition\.planning/);
  });

  it("wrong schema version is rejected", async () => {
    const { root } = tmpPersonaDir({
      "persona.yaml": VALID_YAML.replace("schema: 1", "schema: 2"),
      "SOUL.md": "s",
      "CONTRACT.md": "c",
      "USER.md": "u",
      "MEMORY.md": "m",
    });
    await expect(loadPersona(root, "partial")).rejects.toThrowError(/schema/);
  });

  it("invalid YAML throws naming the file", async () => {
    const { root } = tmpPersonaDir({
      "persona.yaml": "id: [unclosed",
      "SOUL.md": "s",
      "CONTRACT.md": "c",
      "USER.md": "u",
      "MEMORY.md": "m",
    });
    try {
      await loadPersona(root, "partial");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PersonaLoadError);
      const e = err as PersonaLoadError;
      expect(e.code).toBe("validation_failed");
      expect(e.message).toContain("persona.yaml");
    }
  });

  it("rejects path-traversal persona ids", async () => {
    await expect(loadPersona(realPersonasRoot, "../default")).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("keeps unknown fields via passthrough (forward compat)", () => {
    const parsed = PersonaSchema.safeParse({
      schema: 1,
      id: "x",
      name: "X",
      voice: { register: "peer", verbosity: "normal", future_field: 7 },
      cognition: { planning: "auto" },
      contract: { honesty: {}, scope: {}, escalate: [], always: [] },
      capabilities: { domains: [], tools_allow: [], tools_deny: [] },
      memory: { scopes: [] },
      future_top_level: { a: 1 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data.voice as Record<string, unknown>)["future_field"]).toBe(7);
      expect((parsed.data as Record<string, unknown>)["future_top_level"]).toEqual({ a: 1 });
    }
  });
});
