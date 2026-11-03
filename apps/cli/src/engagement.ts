// SPDX-License-Identifier: AGPL-3.0-or-later
// `--engagement <json-file>` loading: parse, validate against the frozen
// EngagementSchema, validate targets with @nyx/scope, refuse expired
// engagements up front (the scope engine would deny everything anyway — a
// clear early error beats a confusing mid-turn denial).

import { readFile } from "node:fs/promises";
import { EngagementSchema } from "@nyx/protocol";
import type { Engagement } from "@nyx/protocol";
import { validateTargets } from "@nyx/scope";
import { CliError } from "./errors.js";

export async function loadEngagementFile(path: string, now: () => number = Date.now): Promise<Engagement> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new CliError("validation_failed", `cannot read engagement file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new CliError("validation_failed", `engagement file ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parsed = EngagementSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new CliError("validation_failed", `invalid engagement in ${path}: ${issues}`);
  }

  const problems = validateTargets(parsed.data.targets);
  if (problems.length > 0) {
    throw new CliError("validation_failed", `invalid engagement targets in ${path}: ${problems.join("; ")}`);
  }

  if (parsed.data.expires_at <= now()) {
    throw new CliError(
      "validation_failed",
      `engagement ${parsed.data.id} in ${path} expired at ${new Date(parsed.data.expires_at).toISOString()}`,
    );
  }
  return parsed.data;
}
