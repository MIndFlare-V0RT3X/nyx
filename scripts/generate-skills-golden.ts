// Generates the golden system-prompt fixture by running the REAL catalog
// pipeline (scan → filter → curate → render) over a fixture skills dir and
// the same fake-persona section assembly the golden test uses.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SECTION_ORDER } from "../packages/protocol/dist/index.js";
import { SkillsProvider } from "../packages/skills/dist/index.js";

const skillsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-golden-gen-"));
const writeSkill = async (name: string, fm: string, body: string): Promise<void> => {
  await fsp.mkdir(path.join(skillsDir, name), { recursive: true });
  await fsp.writeFile(path.join(skillsDir, name, "SKILL.md"), `---\n${fm}\n---\n\n${body}\n`, "utf8");
};
await writeSkill(
  "deploy",
  "name: deploy\ndescription: Production deploy runbook steps.\nwhen_to_use: deploying to prod\nversion: 1.0.0\ntools: [shell.exec]",
  "DEPLOY BODY",
);
await writeSkill("review", "name: review\ndescription: Code review checklist for this repo.", "REVIEW BODY");
await writeSkill(
  "sre-only",
  "name: sre-only\ndescription: Scoped away from the default persona.\npersona_scope: [sre]",
  "SRE BODY",
);

// A bare in-memory store is enough: the provider only reads meta.
const { openSessionStore } = await import("../packages/session/dist/index.js");
const store = openSessionStore(":memory:");
const session = await store.create({ owner_id: "o", persona_id: "default" });

const provider = new SkillsProvider(
  { dirs: [skillsDir], catalog_max_tokens: 2000, pinned: [], excluded: [] },
  { persona_root: "/nonexistent-personas", store, registry: undefined },
);
const body = await provider.catalogBodyFor(session.session_id, "default");

const sections = SECTION_ORDER.map((id) => ({
  id,
  title: id,
  body: id === "SKILLS_CATALOG" ? body : `${id} body.`,
}));
const assembled = sections.map((s) => `## ${s.title}\n${s.body}`).join("\n\n");

const out = path.join(import.meta.dirname, "../packages/skills/src/__golden__/system-prompt.txt");
await fsp.writeFile(out, assembled + "\n", "utf8");
console.log(assembled);
store.close();
await fsp.rm(skillsDir, { recursive: true, force: true });
