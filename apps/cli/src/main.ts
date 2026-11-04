#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// The nyx binary entry: a thin Commander tree over the testable core in
// src/index.ts. No logic lives here — argument parsing, config/data-dir
// resolution, output, and exit codes only.

import { Command } from "commander";
import { join } from "node:path";
import { resolveCliConfig, resolveDataDir } from "./config.js";
import { runOneShot } from "./run.js";
import { loadEngagementFile } from "./engagement.js";
import { createLocalRuntime } from "./local.js";
import { createChatDriver } from "./chat-driver.js";
import { startChatTui } from "./chat.js";
import {
  forkSession,
  listSessions,
  renderSessionDetail,
  renderSessionEvents,
  renderSessionList,
  showSession,
} from "./sessions.js";
import { listApprovals, renderApprovalList, resolveApproval } from "./approvals.js";
import { abortSubagent, listSubagents, renderSubagentList } from "./subagents.js";
import {
  listTasks,
  mutateTask,
  renderTaskDetail,
  renderTaskList,
  showTask,
} from "./tasks.js";
import { listDeclaredModels, renderModels } from "./models.js";
import { validateConfigFile } from "./validate.js";
import { doctorChecks, renderDoctorReport } from "./doctor.js";
import { initNextSteps, runInit, STARTER_CONFIG_NAME } from "./init.js";
import {
  bootstrapUserMd,
  createReadlinePrompter,
  userMdNote,
} from "./user-md.js";
import { CliError } from "./errors.js";

const CLI_ID = "nyx/0.1.0";

function fatal(message: string): never {
  process.stderr.write(`nyx: ${message}\n`);
  process.exitCode = 1;
  throw new ProcessExitError();
}

class ProcessExitError extends Error {
  constructor() {
    super("process exit");
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("nyx")
    .description("NYX — local-first personal agent runtime (the harness, not the model)")
    .version(CLI_ID);

  program
    .command("init")
    .description(
      `write a starter ${STARTER_CONFIG_NAME} in the current directory (offline defaults: mock provider, local sandbox)`,
    )
    .option("--force", "overwrite an existing config file")
    .option("--yes", "non-interactive: write the USER.md template unchanged, no prompts")
    .action(async (opts: { force?: boolean; yes?: boolean }) => {
      const result = await runInit(process.cwd(), { force: opts.force === true });
      if (result.refused) {
        process.stdout.write(
          `${result.path} already exists — pass --force to overwrite (nothing was written)\n`,
        );
        return;
      }
      // First-run profile bootstrap: prompt for name/timezone/standing
      // instructions and write them into the default persona's USER.md.
      // Skips when the file already has real content; --yes writes the
      // template unchanged.
      const bootstrap = await bootstrapUserMd({
        personaDir: join(process.cwd(), "personas", "default"),
        ...(opts.yes === true ? {} : { prompter: createReadlinePrompter() }),
        yes: opts.yes === true,
      });
      process.stdout.write(`${userMdNote(bootstrap)}\n`);
      process.stdout.write(`${initNextSteps(result)}\n`);
    });

  program
    .command("run")
    .description(
      "one-shot non-interactive turn: stream the reply to stdout, exit 0/1 (approvals auto-deny)",
    )
    .argument("<message>", "the user message for the turn")
    .option("--persona <id>", "persona id for a new session")
    .option("--engagement <file>", "engagement YAML file bound at session creation (JSON also accepted)")
    .option("--session <id>", "reuse an existing session")
    .action(
      async (
        message: string,
        opts: { persona?: string; engagement?: string; session?: string },
      ) => {
        const { config } = await resolveCliConfig();
        const engagement =
          opts.engagement !== undefined
            ? (await loadEngagementFile(opts.engagement)).engagement
            : undefined;
        const result = await runOneShot({
          config,
          data_dir: resolveDataDir(),
          message,
          ...(opts.session !== undefined ? { session_id: opts.session } : {}),
          ...(opts.persona !== undefined ? { persona_id: opts.persona } : {}),
          ...(engagement !== undefined ? { engagement } : {}),
        });
        process.exitCode = result.exit_code;
      },
    );

  program
    .command("chat")
    .description(
      "interactive TUI: streaming replies, tool transcript, approvals (y/n), usage footer",
    )
    .option("--session <id>", "reuse an existing session (a new one is created by default)")
    .option("--persona <id>", "persona id for a new session")
    .option("--engagement <file>", "engagement YAML file bound at session creation (JSON also accepted)")
    .action(async (opts: { session?: string; persona?: string; engagement?: string }) => {
      if (process.stdin.isTTY !== true) {
        fatal(
          'chat requires an interactive terminal (stdin is not a TTY); use `nyx run "<message>"` for one-shot turns',
        );
      }
      const { config } = await resolveCliConfig();
      const engagement =
        opts.engagement !== undefined
          ? (await loadEngagementFile(opts.engagement)).engagement
          : undefined;
      let driver: ReturnType<typeof createChatDriver> | undefined;
      const runtime = createLocalRuntime({
        config,
        data_dir: resolveDataDir(),
        approval_mode: "interactive",
        on_approval_event: (event, record) => {
          driver?.onApprovalEvent(event, record);
        },
      });
      try {
        const session =
          opts.session !== undefined
            ? ((await runtime.meta(opts.session)) ?? fatal(`session ${opts.session} not found`))
            : await runtime.createSession({
                ...(opts.persona !== undefined ? { persona_id: opts.persona } : {}),
                ...(engagement !== undefined ? { engagement } : {}),
              });
        process.stdout.write(
          `nyx chat — session ${session.session_id} (persona ${session.persona_id})\n`,
        );
        driver = createChatDriver({ runtime, session });
        const tui = startChatTui(driver, config.owner_id);
        process.on("SIGINT", () => driver?.requestExit());
        await tui.waitUntilExit();
        await driver.idle();
      } finally {
        await runtime.close();
      }
    });

  const sessions = program.command("sessions").description("session projections");
  sessions
    .command("list")
    .description("sessions: id, title, turns, updated (subagents hidden unless --all)")
    .option("--limit <n>", "maximum sessions to show", "50")
    .option("--all", "include subagent sessions (shown with a ↳ prefix and parent)")
    .action(async (opts: { limit: string; all?: boolean }) => {
      const limit = Number.parseInt(opts.limit, 10);
      const rows = await listSessions(
        resolveDataDir(),
        Number.isFinite(limit) && limit > 0 ? limit : 50,
        opts.all === true,
      );
      process.stdout.write(`${renderSessionList(rows)}\n`);
    });
  sessions
    .command("show")
    .description(
      "one session: messages, tool calls, approvals, usage (or --events for the raw log)",
    )
    .argument("<id>", "session id")
    .option("--events", "render the raw event log instead of the projection")
    .action(async (id: string, opts: { events?: boolean }) => {
      const detail = await showSession(resolveDataDir(), id);
      process.stdout.write(
        `${opts.events === true ? renderSessionEvents(detail) : renderSessionDetail(detail)}\n`,
      );
    });
  sessions
    .command("fork")
    .description("fork a session at an inclusive seq boundary; prints the child id")
    .argument("<id>", "parent session id")
    .argument("<at_seq>", "fork point (inclusive seq)", (value: string) =>
      Number.parseInt(value, 10),
    )
    .action(async (id: string, at_seq: number) => {
      const child = await forkSession(resolveDataDir(), id, at_seq);
      process.stdout.write(`${child.session_id}\n`);
    });

  const subagents = program.command("subagents").description("subagent children of a session");
  subagents
    .command("list")
    .description("a parent session's subagents: id, state, spawned, turn, task")
    .argument("<parent_id>", "parent session id")
    .action(async (parent_id: string) => {
      const rows = await listSubagents(resolveDataDir(), parent_id);
      process.stdout.write(`${renderSubagentList(rows)}\n`);
    });
  subagents
    .command("abort")
    .description("abort a running subagent (delivered to the owning process via nyx.db)")
    .argument("<child_id>", "subagent session id")
    .action(async (child_id: string) => {
      const { config } = await resolveCliConfig();
      const result = await abortSubagent(resolveDataDir(), child_id, `cli:${config.owner_id}`);
      process.stdout.write(`${result.note}\n`);
      if (!result.requested) process.exitCode = 1;
    });

  const tasksCmd = program
    .command("tasks")
    .description("durable tasks: long-running work that survives restart");
  tasksCmd
    .command("list")
    .description("tasks: id, state, attempts, next attempt, title")
    .option("--state <s>", "filter by comma-separated states (pending,running,paused,completed,failed,cancelled)")
    .option("--parent <id>", "filter by the parent session the task is bound to")
    .option("--limit <n>", "maximum tasks to show", "50")
    .action(async (opts: { state?: string; parent?: string; limit: string }) => {
      const limit = Number.parseInt(opts.limit, 10);
      const rows = await listTasks(resolveDataDir(), {
        ...(opts.state !== undefined ? { state: opts.state } : {}),
        ...(opts.parent !== undefined ? { parent_session_id: opts.parent } : {}),
        limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
      });
      process.stdout.write(`${renderTaskList(rows)}\n`);
    });
  tasksCmd
    .command("show")
    .description("one task: state, lineage, lease, last error, result")
    .argument("<id>", "task id")
    .action(async (id: string) => {
      process.stdout.write(`${renderTaskDetail(await showTask(resolveDataDir(), id))}\n`);
    });
  tasksCmd
    .command("pause")
    .description("pause a pending/running task (a running attempt aborts)")
    .argument("<id>", "task id")
    .action(async (id: string) => {
      const { config } = await resolveCliConfig();
      const { note } = await mutateTask(resolveDataDir(), id, "pause", `cli:${config.owner_id}`);
      process.stdout.write(`${note}\n`);
    });
  tasksCmd
    .command("resume")
    .description("resume a paused task (returns it to pending)")
    .argument("<id>", "task id")
    .action(async (id: string) => {
      const { note } = await mutateTask(resolveDataDir(), id, "resume", "cli");
      process.stdout.write(`${note}\n`);
    });
  tasksCmd
    .command("retry")
    .description("reset a failed/cancelled task to pending with attempts zeroed")
    .argument("<id>", "task id")
    .action(async (id: string) => {
      const { note } = await mutateTask(resolveDataDir(), id, "retry", "cli");
      process.stdout.write(`${note}\n`);
    });
  tasksCmd
    .command("cancel")
    .description("hard-stop a task from any state (a running attempt aborts)")
    .argument("<id>", "task id")
    .action(async (id: string) => {
      const { config } = await resolveCliConfig();
      const { note } = await mutateTask(resolveDataDir(), id, "cancel", `cli:${config.owner_id}`);
      process.stdout.write(`${note}\n`);
    });

  const approvals = program.command("approvals").description("pending approvals");
  approvals
    .command("list")
    .description("pending approvals with risk, summary, and remaining TTL")
    .option("--session <id>", "restrict to one session (default: every session)")
    .action(async (opts: { session?: string }) => {
      const rows = await listApprovals(resolveDataDir(), opts.session);
      process.stdout.write(`${renderApprovalList(rows)}\n`);
    });
  approvals
    .command("resolve")
    .description("resolve a pending approval")
    .argument("<id>", "approval id")
    .argument("<decision>", "allow or deny")
    .action(async (id: string, decision: string) => {
      if (decision !== "allow" && decision !== "deny") {
        fatal(`decision must be "allow" or "deny", got "${decision}"`);
      }
      const { config } = await resolveCliConfig();
      const record = await resolveApproval({
        data_dir: resolveDataDir(),
        id,
        decision,
        decided_by: config.owner_id,
      });
      process.stdout.write(
        `approval ${record.id} → ${record.decision} (by ${record.decided_by})\n`,
      );
    });

  const models = program.command("models").description("model catalog");
  models
    .command("list")
    .description("declared models per provider (offline)")
    .action(async () => {
      const { config } = await resolveCliConfig();
      process.stdout.write(`${renderModels(await listDeclaredModels(config))}\n`);
    });

  program
    .command("config")
    .description("config tooling")
    .command("validate")
    .description("load + validate a config file and print the precise error on failure")
    .argument("[path]", `config file path (default: ${STARTER_CONFIG_NAME})`, STARTER_CONFIG_NAME)
    .action(async (path: string) => {
      const result = await validateConfigFile(path);
      if (result.ok) {
        process.stdout.write(`\u2713 ${result.path}: config OK\n`);
        return;
      }
      process.stdout.write(`\u2717 ${result.path}\n${result.message}\n`);
      process.exitCode = 1;
    });

  program
    .command("doctor")
    .description("report node, sqlite, config, docker, provider, and sandbox health")
    .action(async () => {
      const report = await doctorChecks();
      process.stdout.write(`${renderDoctorReport(report)}\n`);
      process.exitCode = report.exit_code;
    });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  if (err instanceof ProcessExitError) return;
  if (err instanceof CliError) {
    process.stderr.write(`nyx: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(
    `nyx: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exitCode = 1;
});
