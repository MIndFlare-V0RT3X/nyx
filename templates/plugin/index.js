// SPDX-License-Identifier: AGPL-3.0-or-later
// The NYX plugin template — copy this directory, rename, and fill in your
// tool. `setup(kernel)` runs inside your plugin's enforcement context: every
// tool you register is checked against the `capabilities` your manifest
// declares, so declare exactly what you exercise (no more, no less).
//
// The manifest is manifest.json — NOT anything in this file. You cannot lie
// about your name, version, capabilities, or integrity from code: the loader
// takes the manifest from disk, verifies the sha256 of this file against it,
// and the kernel re-validates it at use() time.

export async function setup(kernel) {
  kernel.tools.register(
    {
      name: "example-hello",
      description: "The template's demo tool: echoes a greeting.",
      input_schema: {
        type: "object",
        properties: {
          who: { type: "string", description: "Who to greet" },
        },
      },
      risk: "R0",
      capabilities: [],
      handler: "plugin:example-plugin/example-hello",
    },
    {
      execute: async (call) => {
        const who = typeof call.input.who === "string" && call.input.who.length > 0
          ? call.input.who
          : "world";
        return { kind: "text", text: `hello, ${who}` };
      },
    },
  );
}

export async function teardown() {
  // Unregister nothing by hand: the kernel removes every tool, hook, and
  // `plugin:example-plugin:`-namespaced service your setup registered.
}
