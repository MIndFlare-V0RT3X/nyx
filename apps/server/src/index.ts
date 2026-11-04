// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/server — public surface: the Hono app factory, lifecycle types, and
// the supporting modules other surfaces/tests reuse (auth, logger, sink).

export { createServer } from "./server.js";
export type { ServerDeps, NyxServer } from "./server.js";
export { createEventSink } from "./eventsink.js";
export type { EventSink } from "./eventsink.js";
export { createLogger } from "./logger.js";
export type { LogLevel, LoggingConfig, LoggerOptions } from "./logger.js";
export { resolveAuth, authenticate, randomToken } from "./auth.js";
export type { Actor, ResolvedAuth } from "./auth.js";
export {
  buildProviders,
  ReusableMockProvider,
  ServerConfigError,
  MOCK_PROVIDER_MESSAGE,
} from "./providers.js";
export { SERVER_ID, SERVER_VERSION } from "./version.js";
export { injectWebSocketServer, WS_PATH } from "./ws.js";
export type { WebSocketDeps, WebSocketHub } from "./ws.js";
