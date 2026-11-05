// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import type { InitContext } from "@nyx/protocol";
import { HookBusImpl } from "./hooks.js";
import type { HookScope } from "./hooks.js";
import { HookExecutionError } from "./errors.js";

function makeScope() {
  let current: string | null = null;
  const scope: HookScope = {
    currentPlugin: () => current,
    run: <T>(_plugin: string | null, fn: () => T): T => fn(),
    capture: () => undefined,
    release: () => undefined,
  };
  return {
    scope,
    setCurrent: (plugin: string | null) => {
      current = plugin;
    },
  };
}

const ctx: InitContext = {
  session_id: "s1",
  turn_id: "t1",
  sections: [],
  messages: [],
  facts: {},
};

describe("HookBusImpl ordering", () => {
  it("runs higher priority first", async () => {
    const bus = new HookBusImpl(makeScope().scope);
    const order: string[] = [];
    bus.on("context.initialize", async () => void order.push("low"), { priority: 1 });
    bus.on("context.initialize", async () => void order.push("high"), { priority: 10 });
    bus.on("context.initialize", async () => void order.push("mid"), { priority: 5 });
    await bus.emit("context.initialize", ctx);
    expect(order).toEqual(["high", "mid", "low"]);
  });

  it("breaks priority ties in registration order", async () => {
    const bus = new HookBusImpl(makeScope().scope);
    const order: string[] = [];
    bus.on("context.initialize", async () => void order.push("first"), { priority: 5 });
    bus.on("context.initialize", async () => void order.push("second"), { priority: 5 });
    bus.on("context.initialize", async () => void order.push("third"), { priority: 5 });
    await bus.emit("context.initialize", ctx);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("defaults priority to 0", async () => {
    const bus = new HookBusImpl(makeScope().scope);
    const order: string[] = [];
    bus.on("context.initialize", async () => void order.push("default"));
    bus.on("context.initialize", async () => void order.push("neg"), { priority: -1 });
    bus.on("context.initialize", async () => void order.push("pos"), { priority: 1 });
    await bus.emit("context.initialize", ctx);
    expect(order).toEqual(["pos", "default", "neg"]);
  });

  it("emits to only the named hook", async () => {
    const bus = new HookBusImpl(makeScope().scope);
    const other = vi.fn(async () => undefined);
    bus.on("context.initialize", async () => undefined);
    bus.on("action.after", other);
    const results = await bus.emit("context.initialize", ctx);
    expect(other).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
  });
});

describe("HookBusImpl results and unsubscribe", () => {
  it("returns results in execution order, voids preserved as undefined", async () => {
    const bus = new HookBusImpl(makeScope().scope);
    bus.on("context.initialize", async () => ({ facts: { from: "priority-1" } }), { priority: 1 });
    bus.on("context.initialize", async () => undefined, { priority: 0 });
    bus.on("context.initialize", async () => ({ facts: { from: "priority--1" } }), {
      priority: -1,
    });
    const results = await bus.emit("context.initialize", ctx);
    expect(results).toEqual([
      { facts: { from: "priority-1" } },
      undefined,
      { facts: { from: "priority--1" } },
    ]);
  });

  it("unsubscribe stops the hook and is idempotent", async () => {
    const bus = new HookBusImpl(makeScope().scope);
    const fn = vi.fn(async () => undefined);
    const off = bus.on("context.initialize", fn);
    off();
    off();
    const results = await bus.emit("context.initialize", ctx);
    expect(fn).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("hooks registered mid-emit do not join that emit", async () => {
    const bus = new HookBusImpl(makeScope().scope);
    const order: string[] = [];
    bus.on("context.initialize", async () => {
      order.push("first");
      bus.on("context.initialize", async () => void order.push("late"));
    });
    bus.on("context.initialize", async () => void order.push("second"));
    const results = await bus.emit("context.initialize", ctx);
    expect(order).toEqual(["first", "second"]);
    expect(results).toHaveLength(2);
  });
});

describe("HookBusImpl errors", () => {
  it("wraps hook failures naming the hook and plugin, with cause", async () => {
    const bus = new HookBusImpl(makeScope().scope);
    const original = new Error("hook body exploded");
    bus.on(
      "context.initialize",
      async () => {
        throw original;
      },
      { plugin: "my-plugin" },
    );
    const attempt = bus.emit("context.initialize", ctx);
    await expect(attempt).rejects.toBeInstanceOf(HookExecutionError);
    await expect(attempt).rejects.toMatchObject({
      code: "hook_failed",
      hook: "context.initialize",
      plugin: "my-plugin",
      message: expect.stringContaining("my-plugin"),
    });
    await expect(attempt).rejects.toMatchObject({ cause: original });
  });

  it("reports null plugin for host hooks", async () => {
    const bus = new HookBusImpl(makeScope().scope);
    bus.on("context.initialize", async () => {
      throw new Error("nope");
    });
    await expect(bus.emit("context.initialize", ctx)).rejects.toMatchObject({
      hook: "context.initialize",
      plugin: null,
    });
  });

  it("stops at the first failing hook", async () => {
    const bus = new HookBusImpl(makeScope().scope);
    const order: string[] = [];
    bus.on("context.initialize", async () => void order.push("before"), { priority: 10 });
    bus.on(
      "context.initialize",
      async () => {
        order.push("boom");
        throw new Error("boom");
      },
      { priority: 5 },
    );
    bus.on("context.initialize", async () => void order.push("after"), { priority: 1 });
    await expect(bus.emit("context.initialize", ctx)).rejects.toThrowError("boom");
    expect(order).toEqual(["before", "boom"]);
  });
});

describe("HookBusImpl attribution and cleanup", () => {
  it("attributes to the executing plugin over opts.plugin", () => {
    const { scope, setCurrent } = makeScope();
    const bus = new HookBusImpl(scope);
    setCurrent("real-owner");
    bus.on("context.initialize", async () => undefined, { plugin: "imposter" });
    setCurrent(null);
    expect(bus.removePlugin("real-owner")).toBe(1);
    expect(bus.removePlugin("imposter")).toBe(0);
  });

  it("attributes host registrations to opts.plugin when given", () => {
    const bus = new HookBusImpl(makeScope().scope);
    bus.on("context.initialize", async () => undefined, { plugin: "proxied" });
    bus.on("context.initialize", async () => undefined);
    expect(bus.removePlugin("proxied")).toBe(1);
  });

  it("removePlugin removes all hooks of that plugin across names", async () => {
    const bus = new HookBusImpl(makeScope().scope);
    const a = vi.fn(async () => undefined);
    const b = vi.fn(async () => undefined);
    bus.on("context.initialize", a, { plugin: "p" });
    bus.on("action.after", b, { plugin: "p" });
    expect(bus.removePlugin("p")).toBe(2);
    await bus.emit("context.initialize", ctx);
    expect(a).not.toHaveBeenCalled();
  });

  it("clear removes every registration", async () => {
    const bus = new HookBusImpl(makeScope().scope);
    bus.on("context.initialize", async () => undefined, { plugin: "p" });
    bus.on("context.initialize", async () => undefined);
    bus.clear();
    expect(await bus.emit("context.initialize", ctx)).toEqual([]);
  });
});
