// SPDX-License-Identifier: AGPL-3.0-or-later
// Acceptance tests for the first-run USER.md bootstrap (Phase 1 hardening
// 2.4): fresh home prompts and writes a populated profile; an already
// populated profile is skipped; --yes writes the template unchanged; the
// written file carries the prompted fields.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_USER_MD,
  applyToUserMdTemplate,
  bootstrapUserMd,
  isUserMdPopulated,
} from "./user-md.js";
import type { UserMdPrompter } from "./user-md.js";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function freshHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nyx-usermd-"));
  dirs.push(dir);
  return dir;
}

function fakePrompter(answers: {
  name: string;
  timezone: string;
  standingInstructions: string;
}): UserMdPrompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    askName: async () => {
      asked.push("name");
      return answers.name;
    },
    askTimezone: async (defaultTz) => {
      asked.push("timezone");
      return answers.timezone === "" ? defaultTz : answers.timezone;
    },
    askStandingInstructions: async () => {
      asked.push("standing");
      return answers.standingInstructions;
    },
  };
}

describe("isUserMdPopulated", () => {
  it("treats the template placeholder as unpopulated and real names as populated", () => {
    expect(isUserMdPopulated(DEFAULT_USER_MD)).toBe(false);
    expect(
      isUserMdPopulated(
        DEFAULT_USER_MD.replace(
          "- Name: (fill in — what the assistant should call you)",
          "- Name: Rizz",
        ),
      ),
    ).toBe(true);
    // Empty value → still template-shaped.
    expect(isUserMdPopulated("- Name: \n- Timezone: UTC")).toBe(false);
    // Custom shape without a Name line → never clobbered.
    expect(isUserMdPopulated("# just some notes\nhello")).toBe(true);
  });
});

describe("applyToUserMdTemplate", () => {
  it("fills name, timezone, and standing instructions; leaves the rest intact", () => {
    const out = applyToUserMdTemplate(DEFAULT_USER_MD, {
      name: "Rizz",
      timezone: "Europe/Berlin",
      standingInstructions: "cite primary sources\nask before any git push",
    });
    expect(out).toContain("- Name: Rizz");
    expect(out).toContain("- Timezone: Europe/Berlin");
    expect(out).toContain("- cite primary sources");
    expect(out).toContain("- ask before any git push");
    expect(out).not.toContain("(fill in — what the assistant should call you)");
    expect(out).not.toContain('(e.g. "cite primary sources for any security claim")');
    // Untouched sections survive.
    expect(out).toContain("## Communication preferences");
    expect(out).toContain("## Current projects");
    expect(out).toContain('(e.g. "NYX Phase 1 — channels")');
  });

  it("empty answers keep the template placeholders", () => {
    const out = applyToUserMdTemplate(DEFAULT_USER_MD, {
      name: "",
      timezone: "",
      standingInstructions: "",
    });
    expect(out).toBe(DEFAULT_USER_MD);
  });
});

describe("bootstrapUserMd", () => {
  it("on a fresh home it prompts and writes a populated USER.md (no repo persona source)", async () => {
    const home = await freshHome();
    const personaDir = join(home, "personas", "default");
    const prompter = fakePrompter({
      name: "Rizz",
      timezone: "Asia/Karachi",
      standingInstructions: "cite primary sources for any security claim",
    });

    const result = await bootstrapUserMd({
      personaDir,
      prompter,
      repoPersonaSource: join(home, "no-such-source"), // force the embedded template
      defaultTimezone: "UTC",
    });

    expect(result.action).toBe("populated");
    expect(result.path).toBe(join(personaDir, "USER.md"));
    const written = await readFile(result.path, "utf8");
    expect(written).toContain("- Name: Rizz");
    expect(written).toContain("- Timezone: Asia/Karachi");
    expect(written).toContain("- cite primary sources for any security claim");
    expect(isUserMdPopulated(written)).toBe(true);
    expect(prompter.asked).toEqual(["name", "timezone", "standing"]);
  });

  it("on an already populated USER.md it skips the prompt entirely", async () => {
    const home = await freshHome();
    const personaDir = join(home, "personas", "default");
    const populated = applyToUserMdTemplate(DEFAULT_USER_MD, {
      name: "Existing",
      timezone: "UTC",
      standingInstructions: "",
    });
    await import("node:fs/promises").then((fsp) => fsp.mkdir(personaDir, { recursive: true }));
    await writeFile(join(personaDir, "USER.md"), populated, "utf8");
    const prompter = fakePrompter({
      name: "ShouldNot",
      timezone: "BeAsked",
      standingInstructions: "",
    });

    const result = await bootstrapUserMd({
      personaDir,
      prompter,
      defaultTimezone: "UTC",
    });

    expect(result.action).toBe("skipped-existing");
    expect(prompter.asked).toEqual([]);
    const text = await readFile(join(personaDir, "USER.md"), "utf8");
    expect(text).toContain("- Name: Existing");
    expect(text).not.toContain("ShouldNot");
  });

  it("--yes writes the template unchanged without prompting", async () => {
    const home = await freshHome();
    const personaDir = join(home, "personas", "default");
    const prompter = fakePrompter({
      name: "Nope",
      timezone: "Nope",
      standingInstructions: "",
    });

    const result = await bootstrapUserMd({
      personaDir,
      yes: true,
      repoPersonaSource: join(home, "no-such-source"),
      defaultTimezone: "UTC",
    });

    expect(result.action).toBe("template-written");
    expect(prompter.asked).toEqual([]); // --yes ignores the prompter entirely
    const text = await readFile(join(personaDir, "USER.md"), "utf8");
    expect(text).toBe(DEFAULT_USER_MD);
    expect(text).toContain("(fill in — what the assistant should call you)");

    // --yes on an existing placeholder file leaves it as it is.
    const again = await bootstrapUserMd({
      personaDir,
      yes: true,
      defaultTimezone: "UTC",
    });
    expect(again.action).toBe("template-written");
    expect(await readFile(join(personaDir, "USER.md"), "utf8")).toBe(DEFAULT_USER_MD);
  });

  it("copies the repo default persona when the target is missing and a source exists", async () => {
    const home = await freshHome();
    const personaDir = join(home, "personas", "default");
    const source = join(home, "source-persona");
    await import("node:fs/promises").then((fsp) => fsp.mkdir(source, { recursive: true }));
    await writeFile(join(source, "USER.md"), DEFAULT_USER_MD, "utf8");
    await writeFile(join(source, "SOUL.md"), "# SOUL\n", "utf8");

    const prompter = fakePrompter({
      name: "Rizz",
      timezone: "UTC",
      standingInstructions: "",
    });
    const result = await bootstrapUserMd({
      personaDir,
      prompter,
      repoPersonaSource: source,
      defaultTimezone: "UTC",
    });

    expect(result.action).toBe("populated");
    // The whole persona came along, not just USER.md.
    expect(await readFile(join(personaDir, "SOUL.md"), "utf8")).toBe("# SOUL\n");
    expect(await readFile(join(personaDir, "USER.md"), "utf8")).toContain("- Name: Rizz");
  });
});
