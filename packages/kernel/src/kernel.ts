// SPDX-License-Identifier: AGPL-3.0-or-later
// The NYX kernel: plugin lifecycle, capability enforcement, hook bus wiring,
// and the service registry.
//
// Enforcement model: any call into `kernel.tools` / `kernel.services` /
// `kernel.hooks` made from plugin code — during setup, teardown, or one of the
// plugin's own hook callbacks — runs inside that plugin's AsyncLocalStorage
// context and is checked against its manifest (declared-capability subset for
// tool registration, `plugin:<name>:` namespace for services, ownership for
// unregister/delete). Calls from host code are unrestricted. The context is
// ambient, so attribution is correct across `await` boundaries and does not
// leak to interleaved host code.

import { AsyncLocalStorage } from "node:async_hooks";
import { CapabilityError } from "@nyx/protocol";
import type {
  Capability,
  Kernel,
  Plugin,
  PluginAuditRecord,
  PluginManifest,
  ServiceRegistry,
  ToolDefinition,
  ToolHandler,
  ToolRegistry,
} from "@nyx/protocol";
import { HookBusImpl } from "./hooks.js";
import type { HookScope } from "./hooks.js";
import {
  DependencyVersionError,
  DuplicatePluginError,
  KernelClosedError,
  ManifestValidationError,
  MissingDependencyError,
  PluginInUseError,
  PluginMutationError,
  PluginTeardownError,
  PluginVersionError,
  ServiceNamespaceError,
  ToolOwnershipError,
  UnknownPluginError,
} from "./errors.js";
import { manifestIssues, pluginManifestSchema, v1MigrationHints } from "./manifest.js";
import { ServiceRegistryImpl, ToolRegistryImpl } from "./registry.js";
import { satisfies } from "./semver.js";

export interface KernelOptions {
  /** Kernel API version plugin ranges are checked against. Default "0.1.0". */
  version?: string;
  /** Backing tool registry; a fresh one is created when omitted. */
  tools?: ToolRegistry;
}

type EnforcementState = { plugin: string; manifest?: PluginManifest } | { plugin: null };

interface LoadedPlugin {
  plugin: Plugin;
  manifest: PluginManifest;
}

export class KernelImpl implements Kernel {
  readonly version: string;
  readonly hooks: HookBusImpl;
  readonly tools: ToolRegistry;
  readonly services: ServiceRegistry;

  readonly #backingTools: ToolRegistry;
  readonly #backingServices = new ServiceRegistryImpl();
  /** tool name → owning plugin name (null = host). */
  readonly #toolOwners = new Map<string, string | null>();
  /** Loaded plugins in setup order (Map preserves insertion order). */
  readonly #plugins = new Map<string, LoadedPlugin>();
  /** Manifests of plugins whose setup is still running (hook owners need them). */
  readonly #loading = new Map<string, PluginManifest>();
  /** Capabilities each plugin actually exercised (tool registrations). */
  readonly #usedCapabilities = new Map<string, Set<Capability>>();
  readonly #als = new AsyncLocalStorage<EnforcementState>();
  #closed = false;

  constructor(options?: KernelOptions) {
    this.version = options?.version ?? "0.1.0";
    this.#backingTools = options?.tools ?? new ToolRegistryImpl();
    this.hooks = new HookBusImpl(this.#hookScope());
    this.tools = this.#toolFacade();
    this.services = this.#serviceFacade();
  }

  /**
   * Validate the manifest (v2), check version compatibility and dependencies
   * (names present, versions in range), refuse mutation from plugin code,
   * then run `plugin.setup` inside the plugin's enforcement context. If
   * setup throws, nothing the plugin registered survives and the error
   * propagates unwrapped.
   */
  async use(plugin: Plugin): Promise<void> {
    if (this.#closed) throw new KernelClosedError("use");
    this.#refusePluginMutation("use");
    const manifest = this.#validateManifest(plugin);
    if (this.#plugins.has(manifest.name) || this.#loading.has(manifest.name)) {
      throw new DuplicatePluginError(manifest.name);
    }
    if (!satisfies(manifest.nyx, this.version)) {
      throw new PluginVersionError(manifest.name, manifest.nyx, this.version);
    }
    // Topological order is load order: dependencies must already be loaded
    // at a version inside the declared range (Phase 7.2 manifest v2).
    const missing = (manifest.dependencies ?? [])
      .filter((dep) => !this.#plugins.has(dep.name))
      .map((dep) => dep.name);
    if (missing.length > 0) throw new MissingDependencyError(manifest.name, missing);
    const mismatches = (manifest.dependencies ?? [])
      .map((dep) => {
        const loaded = this.#plugins.get(dep.name);
        return loaded !== undefined && !satisfies(dep.version_range, loaded.manifest.version)
          ? { name: dep.name, loaded: loaded.manifest.version, range: dep.version_range }
          : null;
      })
      .filter((m): m is { name: string; loaded: string; range: string } => m !== null);
    if (mismatches.length > 0) throw new DependencyVersionError(manifest.name, mismatches);

    this.#loading.set(manifest.name, manifest);
    try {
      await this.#als.run({ plugin: manifest.name, manifest }, () => plugin.setup(this));
    } catch (err) {
      this.#unloadRegistrations(manifest.name);
      throw err;
    } finally {
      this.#loading.delete(manifest.name);
    }
    this.#plugins.set(manifest.name, { plugin, manifest });
    if (!this.#usedCapabilities.has(manifest.name)) {
      this.#usedCapabilities.set(manifest.name, new Set());
    }
  }

  /**
   * Unload a plugin: refuse while a loaded plugin depends on it, otherwise
   * await its teardown (wrapped, so teardown-time calls stay enforced) and
   * remove its hooks, tools, and namespaced services. Removal happens even if
   * teardown throws; the failure is rethrown as PluginTeardownError.
   */
  async unuse(name: string): Promise<void> {
    if (this.#closed) throw new KernelClosedError("unuse");
    this.#refusePluginMutation("unuse");
    const loaded = this.#plugins.get(name);
    if (!loaded) throw new UnknownPluginError(name);
    const dependents = [...this.#plugins.values()]
      .filter(
        (p) =>
          p.manifest.name !== name &&
          (p.manifest.dependencies ?? []).some((dep) => dep.name === name),
      )
      .map((p) => p.manifest.name);
    if (dependents.length > 0) throw new PluginInUseError(name, dependents);
    try {
      await this.#teardown(loaded);
    } finally {
      this.#plugins.delete(name);
      this.#unloadRegistrations(name);
    }
  }

  /**
   * Tear down every plugin in reverse setup order (each teardown awaited),
   * then clear all state: hooks, tools (including host ones registered through
   * the kernel), and services. Teardown failures do not stop the loop; they
   * surface afterwards as one AggregateError. Idempotent.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failures: PluginTeardownError[] = [];
    for (const loaded of [...this.#plugins.values()].reverse()) {
      try {
        await this.#teardown(loaded);
      } catch (err) {
        failures.push(err as PluginTeardownError);
      }
    }
    this.#plugins.clear();
    this.hooks.clear();
    for (const toolName of this.#toolOwners.keys()) {
      this.#backingTools.unregister(toolName);
    }
    this.#toolOwners.clear();
    this.#backingServices.clear();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `kernel close: ${failures.length} plugin teardown(s) failed`,
      );
    }
  }

  /**
   * Capability audit for every loaded plugin (Phase 7.2): declared vs
   * exercised capabilities; over-declaration surfaces as a warning. The
   * signature/integrity status is the loader's to report (the kernel only
   * sees in-process plugin objects).
   */
  list_plugins(): PluginAuditRecord[] {
    return [...this.#plugins.values()].map(({ manifest }) => {
      const declared = manifest.capabilities;
      const used = [...(this.#usedCapabilities.get(manifest.name) ?? [])];
      const unused = declared.filter((capability) => !used.includes(capability));
      const warnings: string[] = [];
      if (unused.length > 0) {
        warnings.push(
          `declares capability(ies) [${unused.join(", ")}] but never exercised them — remove them from the manifest (over-declaration weakens the audit trail)`,
        );
      }
      return {
        name: manifest.name,
        version: manifest.version,
        nyx: manifest.nyx,
        capabilities: { declared, used },
        ...(manifest.dependencies !== undefined ? { dependencies: manifest.dependencies } : {}),
        warnings,
      } satisfies PluginAuditRecord;
    });
  }

  /**
   * R3-14 closure: plugin code may not mutate the plugin set. A plugin that
   * could `unuse` a neighbor could free its tool names and register its own
   * handlers under them; a plugin that could `use` anything (itself
   * included) could re-register under a fresh name. Only host code loads
   * and unloads plugins.
   */
  #refusePluginMutation(action: "use" | "unuse"): void {
    const active = this.#activeContext();
    if (active !== null) {
      throw new PluginMutationError(active.plugin, action);
    }
  }

  #validateManifest(plugin: Plugin): PluginManifest {
    const raw: unknown = (plugin as { manifest?: unknown } | null | undefined)?.manifest;
    if (typeof raw !== "object" || raw === null) {
      throw new ManifestValidationError("<unknown>", [
        "plugin must be an object with a manifest object",
      ]);
    }
    const parsed = pluginManifestSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    const candidate = (raw as { name?: unknown }).name;
    const name = typeof candidate === "string" && candidate.length > 0 ? candidate : "<unknown>";
    const issues = manifestIssues(parsed.error);
    const hints = v1MigrationHints(raw);
    throw new ManifestValidationError(
      name,
      hints.length > 0 ? [...issues, `v1→v2 migration: ${hints.join("; ")}`] : issues,
    );
  }

  /** Current plugin enforcement context, or null when host code is calling. */
  #activeContext(): { plugin: string; manifest: PluginManifest } | null {
    const store = this.#als.getStore();
    if (!store || store.plugin === null || store.manifest === undefined) return null;
    return { plugin: store.plugin, manifest: store.manifest };
  }

  #hookScope(): HookScope {
    return {
      currentPlugin: () => this.#als.getStore()?.plugin ?? null,
      run: <T>(plugin: string | null, fn: () => T): T => {
        if (plugin === null) return this.#als.run({ plugin: null }, fn);
        const manifest = this.#plugins.get(plugin)?.manifest ?? this.#loading.get(plugin);
        return this.#als.run({ plugin, manifest }, fn);
      },
    };
  }

  #toolFacade(): ToolRegistry {
    return {
      register: (def: ToolDefinition, handler: ToolHandler): void => {
        const active = this.#activeContext();
        if (active) {
          for (const capability of def.capabilities) {
            if (!active.manifest.capabilities.includes(capability)) {
              throw new CapabilityError(active.plugin, capability);
            }
          }
          const owner = this.#toolOwners.get(def.name);
          if (owner !== undefined && owner !== active.plugin) {
            throw new ToolOwnershipError(active.plugin, def.name, owner, "register");
          }
          // Capability audit (Phase 7.2): record what the plugin exercised.
          let used = this.#usedCapabilities.get(active.plugin);
          if (used === undefined) {
            used = new Set();
            this.#usedCapabilities.set(active.plugin, used);
          }
          for (const capability of def.capabilities) used.add(capability);
        }
        this.#backingTools.register(def, handler);
        this.#toolOwners.set(def.name, active ? active.plugin : null);
      },
      unregister: (name: string): void => {
        const active = this.#activeContext();
        if (active) {
          const owner = this.#toolOwners.get(name);
          // A name the kernel never tracked is not the plugin's either.
          if (owner !== active.plugin) {
            throw new ToolOwnershipError(active.plugin, name, owner ?? null, "unregister");
          }
        }
        this.#backingTools.unregister(name);
        this.#toolOwners.delete(name);
      },
      list: (): ToolDefinition[] => this.#backingTools.list(),
      get: (name: string) => this.#backingTools.get(name),
    };
  }

  #serviceFacade(): ServiceRegistry {
    return {
      get: <T>(name: string): T | undefined => this.#backingServices.get<T>(name),
      set: (name: string, service: unknown): void => {
        const active = this.#activeContext();
        if (active && !name.startsWith(`plugin:${active.plugin}:`)) {
          throw new ServiceNamespaceError(active.plugin, name, "set");
        }
        this.#backingServices.set(name, service);
      },
      has: (name: string): boolean => this.#backingServices.has(name),
      delete: (name: string): void => {
        const active = this.#activeContext();
        if (active && !name.startsWith(`plugin:${active.plugin}:`)) {
          throw new ServiceNamespaceError(active.plugin, name, "delete");
        }
        this.#backingServices.delete(name);
      },
    };
  }

  async #teardown(loaded: LoadedPlugin): Promise<void> {
    const teardown = loaded.plugin.teardown;
    if (!teardown) return;
    try {
      await this.#als.run({ plugin: loaded.manifest.name, manifest: loaded.manifest }, () =>
        teardown.call(loaded.plugin),
      );
    } catch (err) {
      throw new PluginTeardownError(loaded.manifest.name, err);
    }
  }

  /** Remove everything a plugin registered: hooks, tools, namespaced services,
   *  and its capability-usage record. */
  #unloadRegistrations(name: string): void {
    this.hooks.removePlugin(name);
    for (const [toolName, owner] of [...this.#toolOwners]) {
      if (owner === name) {
        this.#backingTools.unregister(toolName);
        this.#toolOwners.delete(toolName);
      }
    }
    this.#backingServices.deletePrefixed(`plugin:${name}:`);
    this.#usedCapabilities.delete(name);
  }
}

/** Create a kernel. `version` defaults to "0.1.0". */
export function createKernel(options?: KernelOptions): KernelImpl {
  return new KernelImpl(options);
}
