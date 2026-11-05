// SPDX-License-Identifier: AGPL-3.0-or-later
// Priority-ordered hook bus. Higher priority runs first; ties run in
// registration order. Registrations carry the plugin that made them (taken
// from the kernel's enforcement context) so unuse() can remove them wholesale.
// During emit, every hook callback runs in its owner's enforcement context —
// plugin code never gains host privileges by registering a hook.

import type { HookBus, HookMap, HookName } from "@nyx/protocol";
import { HookExecutionError } from "./errors.js";

/** Attribution + enforcement scope the kernel provides to the bus. */
export interface HookScope {
  /** Plugin whose code is currently executing, or null for host code. */
  currentPlugin(): string | null;
  /** Run `fn` with calls made inside it attributed to `plugin` (null = host). */
  run<T>(plugin: string | null, fn: () => T): T;
  /** R2-3 (fan-out): freeze `plugin`'s enforcement manifest NOW — hook
   *  callbacks keep their registration-time context even if the plugin is
   *  unused while a later emit is still running. */
  capture(plugin: string): void;
  /** Drop the captured context (plugin fully removed). */
  release(plugin: string): void;
}

type AnyHook = HookMap[HookName];

interface HookRegistration {
  seq: number;
  priority: number;
  plugin: string | null;
  fn: AnyHook;
}

export class HookBusImpl implements HookBus {
  #registrations = new Map<HookName, HookRegistration[]>();
  #seq = 0;
  readonly #scope: HookScope;

  constructor(scope: HookScope) {
    this.#scope = scope;
  }

  on<K extends HookName>(
    name: K,
    fn: HookMap[K],
    opts?: { priority?: number; plugin?: string },
  ): () => void {
    const seq = this.#seq++;
    // The executing plugin owns the registration; an explicit opts.plugin is
    // only honored for host code — a plugin cannot re-attribute its hooks.
    const active = this.#scope.currentPlugin();
    const plugin = active ?? opts?.plugin ?? null;
    if (plugin !== null) this.#scope.capture(plugin);
    const reg: HookRegistration = {
      seq,
      priority: opts?.priority ?? 0,
      plugin,
      fn: fn as AnyHook,
    };
    const regs = this.#registrations.get(name);
    if (regs) regs.push(reg);
    else this.#registrations.set(name, [reg]);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const list = this.#registrations.get(name);
      if (!list) return;
      const idx = list.indexOf(reg);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  async emit<K extends HookName>(
    name: K,
    ...args: Parameters<HookMap[K]>
  ): Promise<Array<Awaited<ReturnType<HookMap[K]>>>> {
    // Snapshot: hooks registered or removed during this emit do not affect it.
    const regs = [...(this.#registrations.get(name) ?? [])].sort(
      (a, b) => b.priority - a.priority || a.seq - b.seq,
    );
    const results: Array<Awaited<ReturnType<HookMap[K]>>> = [];
    for (const reg of regs) {
      try {
        const out = await this.#scope.run(reg.plugin, () => this.#invoke(reg, args));
        results.push(out);
      } catch (err) {
        throw new HookExecutionError(name, reg.plugin, err);
      }
    }
    return results;
  }

  /** Internal: call a stored hook with exact argument types (safe upcast). */
  #invoke<K extends HookName>(
    reg: HookRegistration,
    args: Parameters<HookMap[K]>,
  ): ReturnType<HookMap[K]> {
    const fn = reg.fn as unknown as (...a: Parameters<HookMap[K]>) => ReturnType<HookMap[K]>;
    return fn(...args);
  }

  /** Remove every registration owned by `plugin` (unload). Returns the count. */
  removePlugin(plugin: string): number {
    // NOTE (R2-3): the plugin's CAPTURED hook context is intentionally NOT
    // released here — an emit already in flight keeps its registration-time
    // enforcement. A plugin re-registering hooks under the same name
    // overwrites the capture; stale captures are a few small objects.
    let removed = 0;
    for (const [name, regs] of this.#registrations) {
      const kept = regs.filter((r) => r.plugin !== plugin);
      if (kept.length === regs.length) continue;
      removed += regs.length - kept.length;
      if (kept.length === 0) this.#registrations.delete(name);
      else this.#registrations.set(name, kept);
    }
    return removed;
  }

  clear(): void {
    this.#registrations.clear();
  }
}
