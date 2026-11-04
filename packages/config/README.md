# @nyx/config

Loads `nyx.config.yaml`, interpolates `${VAR}` environment references,
validates the result with Zod, applies defaults, and returns a deeply frozen
typed object. It also owns the single `BRAND` constant — every reference to
the product name centralizes there. This package is the only place that knows
the config file's shape; the kernel, server, and CLI consume `NyxConfig`.

## Public exports

```ts
// brand.ts
const BRAND: { readonly name: "nyx"; readonly displayName: "Nyx"; readonly configFileName: "nyx.config.yaml" };
const DEFAULT_CONFIG_PATH: "./nyx.config.yaml";

// schema.ts
const configSchema: z.ZodType<NyxConfig>;          // the Zod schema (reuse/tests)
type NyxConfig;                                     // z.infer<typeof configSchema>
type NyxServerConfig; type NyxProviderConfig; type NyxModelConfig;
type NyxChainStep; type NyxRouteRule; type NyxRouterConfig; type NyxPolicyRuleConfig;

// interpolate.ts
function interpolateEnvVars(
  node: unknown,
  env: Record<string, string | undefined>,
  configPath: string,
): InterpolationResult; // { value, resolvedEnvValues }

// loader.ts
function loadConfig(configPath?: string, opts?: LoadConfigOptions): Promise<NyxConfig>;
interface LoadConfigOptions { env?: Record<string, string | undefined> }

// errors.ts
class ConfigError extends Error { code: "validation_failed" }
```

## Usage

```ts
import { loadConfig, ConfigError, BRAND } from "@nyx/config";

try {
  const config = await loadConfig(); // reads ./nyx.config.yaml
  console.log(BRAND.displayName, "routing via", config.router.default.chain[0].provider);
} catch (err) {
  if (err instanceof ConfigError) {
    // Message names the file path, and where known the YAML line
    // (syntax errors) and the dotted field path (validation errors):
    //   Config validation failed for ./nyx.config.yaml:
    //     at router.default.chain[0].provider: Required
    console.error(err.message);
  }
}
```

See `/nyx.config.example.yaml` at the repo root for a fully commented
reference config.

## Design notes / invariants

- **Validation order**: read file → parse YAML → normalize (empty document or
  a top-level `key:` with nothing under it counts as omitted) → interpolate
  `${VAR}` → Zod-validate → deep-freeze. Interpolation happens before
  validation so error paths refer to the final tree.
- **Env interpolation** applies to string _values_ only, never keys. Only
  POSIX-ish names (`[A-Za-z_][A-Za-z0-9_]*`) interpolate; anything else
  (`$HOME`, `${1bad}`) is left as written. A referenced-but-unset variable is
  a `ConfigError` naming the variable, the file, and the field path. When
  `opts.env` is provided it _replaces_ `process.env` entirely (hermetic
  tests); otherwise `process.env` is used.
- **Never log env-resolved values.** The loader itself never logs, and env
  values that Zod error messages would otherwise echo (enum mismatches) are
  redacted out of `ConfigError` messages.
- **Strictness**: the top level and every nested object are Zod-strict —
  unknown keys (typos) are rejected with the offending key as the field path.
- **Required vs. defaulted**: `router` is the only required top-level section
  (NYX cannot invent a default model route; `router.default.chain` must name
  at least one step). `server` is optional, but when present
  `server.auth.owner_token` is required. Every other section has a default.
  Top-level nulls are treated as omitted so `section:` with nothing under it
  still loads with defaults.
- **`~` expansion**: `sandbox.workdir_root` and `memory.root` expand a
  leading `~` to `os.homedir()` at parse time (defaults included). Other
  paths (e.g. `persona.root`) are left as written.
- **Reserved names**: `server.auth.tokens` may not define the actor `owner`;
  the owner identity is `owner_id` + `owner_token`.
- **Frozen output**: the returned object is deep-frozen at runtime. The
  TypeScript type is deliberately _not_ `Readonly`-mapped so config values
  stay assignable to protocol-typed parameters — treat it as immutable.
- **Policy mirror**: `policy.rules` is validated by a local Zod mirror of
  `@nyx/protocol`'s `PolicyRule` (protocol exports types, not config
  schemas). Compile-time probes in `schema.ts` fail the build if the mirror
  drifts from the frozen contract.
- **Errors**: every failure (unreadable file, YAML syntax, missing env var,
  schema violation) is a `ConfigError` with `code: "validation_failed"` and a
  `cause`. YAML syntax errors include the parser's line/column.

## Intentionally deferred

- Cross-field validation (chain steps referencing provider/model ids that
  exist in `providers`) — done by the kernel at startup, which owns the
  provider registry.
- Watching/reloading config at runtime; merging layered configs
  (user/project/env-file precedence).
- `${VAR:-default}` fallback syntax and `$VAR` shorthand.
- Machine-readable config schema export (JSON Schema) for editor support.
