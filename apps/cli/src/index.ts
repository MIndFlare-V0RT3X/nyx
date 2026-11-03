// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/cli — the nyx binary: a full local runtime in one process plus the
// operator commands around it (init, run, chat, sessions, approvals, models,
// config validate, doctor). This module is the testable core; src/main.ts is
// the thin Commander entry and carries no logic.

// config / data-dir resolution
export {
  CONFIG_PATH_ENV,
  DATA_DIR_ENV,
  DEFAULT_CONFIG_PATH,
  fallbackConfig,
  resolveCliConfig,
  resolveDataDir,
  type ResolvedConfig,
} from "./config.js";
export { ConfigError } from "@nyx/config";

// wiring
export {
  AUTO_DENY_NOTE,
  DEFAULT_AUTO_DENY_MS,
  createLocalRuntime,
  type ApprovalMode,
  type LocalRuntime,
  type LocalRuntimeDeps,
  type TurnInput,
  type TurnRunResult,
} from "./local.js";
export { createEventSink, type EventSink } from "./sink.js";
export {
  MOCK_PROVIDER_MESSAGE,
  ProviderConfigError,
  ReusableMockProvider,
  buildProviders,
} from "./providers.js";
export { createCliLogger, type CliLoggerOptions, type LogLevel, type LoggingConfig } from "./logger.js";
export { loadEngagementFile } from "./engagement.js";

// commands (testable core)
export {
  forkSession,
  listSessions,
  renderSessionDetail,
  renderSessionEvents,
  renderSessionList,
  showSession,
  type SessionDetail,
  type SessionRow,
} from "./sessions.js";
export {
  listApprovals,
  openApprovalSurface,
  renderApprovalList,
  resolveApproval,
  type ApprovalListRow,
  type ApprovalSurface,
  type ResolveApprovalOptions,
} from "./approvals.js";
export {
  listDeclaredModels,
  renderModels,
  type ModelRow,
  type ModelsListing,
} from "./models.js";
export { validateConfigFile, type ValidateConfigResult } from "./validate.js";
export {
  doctorChecks,
  renderDoctorReport,
  type DoctorCheck,
  type DoctorOptions,
  type DoctorReport,
  type DoctorStatus,
} from "./doctor.js";
export {
  STARTER_CONFIG,
  STARTER_CONFIG_NAME,
  initNextSteps,
  runInit,
  type InitResult,
} from "./init.js";

// one-shot runner
export {
  runOneShot,
  StringLineWriter,
  type LineWriter,
  type RunOneShotOptions,
  type RunOneShotResult,
} from "./run.js";

// chat TUI (headless driver + state machine; the Ink view itself is not
// exported as API — it is terminal-only)
export {
  applyApprovalRecord,
  applyEventToChat,
  handleApprovalKey,
  initialChatState,
  moveApprovalSelection,
  submitChatInput,
  type ChatApprovalItem,
  type ChatEntry,
  type ChatEntryKind,
  type ChatState,
  type ChatSubmitResult,
} from "./chat-state.js";
export { createChatDriver, type ChatDriver, type ChatDriverDeps } from "./chat-driver.js";

// errors / formatting
export { CliError, errorMessage, type CliErrorCode } from "./errors.js";
export {
  compactJson,
  describeToolOutput,
  formatDuration,
  formatTimestamp,
  formatUsage,
  truncate,
} from "./format.js";
export { renderTable } from "./table.js";
