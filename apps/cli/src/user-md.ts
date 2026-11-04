// SPDX-License-Identifier: AGPL-3.0-or-later
// First-run USER.md bootstrap (Phase 1 hardening 2.4): `nyx init` prompts the
// operator for name, timezone, and standing instructions and writes them into
// the default persona's USER.md, so the first session already knows who it is
// talking to. A USER.md that already has real content is never touched;
// `nyx init --yes` writes the template without prompting.

import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as os from "node:os";
import * as readline from "node:readline/promises";

/**
 * The USER.md template, mirroring personas/default/USER.md. Written when no
 * persona exists to copy from (an installed binary outside the repo); inside
 * the repo the real personas/default directory is copied instead.
 */
export const DEFAULT_USER_MD = `# USER

The operator profile. Edit this file; it loads after the contract and before
memory. Everything here is visible to the assistant on every turn.

## Identity

- Name: (fill in — what the assistant should call you)
- Timezone: UTC
- Role: (e.g. security consultant, indie developer, researcher)

## Communication preferences

- Direct answers first; detail on request.
- Lowercase chat is fine; deliverables in proper case.
- Say uncertainty in one line, then proceed.

## Standing instructions

- (e.g. "cite primary sources for any security claim")
- (e.g. "ask before any git push, always")

## Current projects

- (e.g. "NYX Phase 1 — channels")
`;

/** What the prompts ask; injectable for tests. */
export interface UserMdPrompter {
  askName(): Promise<string>;
  askTimezone(defaultTz: string): Promise<string>;
  askStandingInstructions(): Promise<string>;
  /** Release any resources (the readline handle); optional. */
  close?(): void;
}

/** The real prompter: readline questions on stdin/stdout. */
export function createReadlinePrompter(): UserMdPrompter {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const once = async (question: string): Promise<string> => {
    const answer = await rl.question(question);
    return answer.trim();
  };
  return {
    askName: () => once("Your name (what the assistant should call you): "),
    askTimezone: (defaultTz) =>
      once(`Your timezone [${defaultTz}]: `).then((a) => (a === "" ? defaultTz : a)),
    askStandingInstructions: async () => {
      const lines: string[] = [];
      for (;;) {
        const answer = (
          await rl.question(
            lines.length === 0
              ? "Standing instructions, one per line (empty line to finish)\n> "
              : "> ",
          )
        ).trim();
        if (answer === "") break;
        lines.push(answer);
      }
      return lines.join("\n");
    },
    close: () => rl.close(),
  };
}

export interface UserMdBootstrapResult {
  /** Absolute path of the USER.md in question. */
  path: string;
  action:
    | "populated" /** prompted and written */
    | "skipped-existing" /** already had real content — untouched */
    | "template-written"; /** written/copied as-is (no prompting: --yes or no tty) */
}

/**
 * True when the file's Name line carries a real value (not the template
 * placeholder and not empty). Files without a "## Identity" Name line count
 * as populated too — custom profiles are never clobbered.
 */
export function isUserMdPopulated(text: string): boolean {
  const nameLine = text
    .split("\n")
    .find((line) => /^- Name:/.test(line.trim()) || /^Name:/.test(line.trim()));
  if (nameLine === undefined) return true; // custom shape — do not touch
  const value = nameLine.replace(/^[^-]*-\s*Name:\s*/, "").replace(/^Name:\s*/, "").trim();
  return value !== "" && !value.startsWith("(fill in");
}

/** Fill the Identity + Standing-instructions fields of the template. */
export function applyToUserMdTemplate(
  template: string,
  answers: { name: string; timezone: string; standingInstructions: string },
): string {
  const lines = template.split("\n");
  const out: string[] = [];
  const instructionLines = answers.standingInstructions
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => `- ${l}`);

  let section: "other" | "identity" | "standing" = "other";
  let standingReplaced = false;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      section = line.includes("Standing instructions") ? "standing" : "other";
      if (section === "standing" && instructionLines.length > 0 && !standingReplaced) {
        out.push(line);
        for (const instruction of instructionLines) out.push(instruction);
        standingReplaced = true;
        // Skip the placeholder bullet lines that follow.
        continue;
      }
      out.push(line);
      continue;
    }
    if (section === "standing" && standingReplaced && /^- \(/.test(line.trim())) {
      continue; // placeholder instruction line, already replaced
    }
    if (/^- Name:/.test(line.trim()) && answers.name !== "") {
      out.push(`- Name: ${answers.name}`);
      continue;
    }
    if (/^- Timezone:/.test(line.trim()) && answers.timezone !== "") {
      out.push(`- Timezone: ${answers.timezone}`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

export interface BootstrapUserMdOptions {
  /** The default persona directory (<persona.root>/default). */
  personaDir: string;
  /** Prompts; when absent (or --yes) the template is written unchanged. */
  prompter?: UserMdPrompter;
  /** Non-interactive: never prompt, never modify an existing file. */
  yes?: boolean;
  /** Overrides the detected timezone default (tests). */
  defaultTimezone?: string;
  /**
   * Where to copy a full default persona from when the target is missing
   * (repo checkouts). Default: ../../../personas/default relative to this
   * module.
   */
  repoPersonaSource?: string;
}

export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export async function bootstrapUserMd(
  opts: BootstrapUserMdOptions,
): Promise<UserMdBootstrapResult> {
  const personaDir = opts.personaDir.startsWith("~/")
    ? join(os.homedir(), opts.personaDir.slice(2))
    : resolve(opts.personaDir);
  const userMdPath = join(personaDir, "USER.md");

  // 1. Obtain the template: existing file, a copied repo persona, or the
  //    embedded default.
  let template: string;
  if (existsSync(userMdPath)) {
    const existing = await readFile(userMdPath, "utf8");
    if (isUserMdPopulated(existing)) {
      return { path: userMdPath, action: "skipped-existing" };
    }
    template = existing;
  } else {
    const source =
      opts.repoPersonaSource ?? resolve(dirname(new URL(import.meta.url).pathname), "../../../personas/default");
    if (existsSync(source)) {
      await cp(source, personaDir, { recursive: true });
      template = await readFile(userMdPath, "utf8");
    } else {
      await mkdir(personaDir, { recursive: true });
      await writeFile(userMdPath, DEFAULT_USER_MD, "utf8");
      template = DEFAULT_USER_MD;
    }
    if (opts.yes === true || opts.prompter === undefined) {
      return { path: userMdPath, action: "template-written" };
    }
  }

  // 2. --yes: the template (just written or already on disk) stays as-is.
  if (opts.yes === true || opts.prompter === undefined) {
    return { path: userMdPath, action: "template-written" };
  }

  // 3. Prompt and write the populated profile.
  const tz = opts.defaultTimezone ?? defaultTimezone();
  try {
    const answers = {
      name: await opts.prompter.askName(),
      timezone: await opts.prompter.askTimezone(tz),
      standingInstructions: await opts.prompter.askStandingInstructions(),
    };
    const populated = applyToUserMdTemplate(template, answers);
    await writeFile(userMdPath, populated, "utf8");
    return { path: userMdPath, action: "populated" };
  } finally {
    opts.prompter.close?.();
  }
}

/** The confirmation line printed after the bootstrap. */
export function userMdNote(result: UserMdBootstrapResult): string {
  switch (result.action) {
    case "populated":
      return `wrote your profile to ${result.path}`;
    case "skipped-existing":
      return `${result.path} already has your profile — left unchanged`;
    case "template-written":
      return `wrote the profile template to ${result.path} — edit it any time`;
  }
}
