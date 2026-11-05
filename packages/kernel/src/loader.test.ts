// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 7.2 — the third-party plugin loader: the runtime-wrapper layer of
// the two-layer discipline (kernel.test.ts holds the direct layer). Every
// test here goes through loadPluginDirectory with REAL files on disk, and
// the happy paths continue into kernel.use().

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createKernel } from "./kernel.js";
import { generateSigningKeypair, sha256Hex, signManifest } from "./signature.js";
import { loadPluginDirectory, resolveSignatureMode } from "./loader.js";
import type { PluginManifest } from "@nyx/protocol";

const INDEX_JS = `export async function setup(kernel) {
  kernel.tools.register({
    name: "hello",
    description: "say hello",
    input_schema: { type: "object", properties: {} },
    risk: "R0",
    capabilities: [],
    handler: "plugin:example/hello",
  }, { execute: async () => ({ kind: "text", text: "hello from plugin" }) });
}
export async function teardown() {}
`;

const tmpDirs: string[] = [];
async function tmpdir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-loader-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of tmpDirs) await fsp.rm(dir, { recursive: true, force: true });
});

interface DirOptions {
  indexSource?: string;
  manifestOverrides?: Partial<PluginManifest>;
  manifestMutator?: (m: Record<string, unknown>) => void;
}

/** Write a real plugin directory: manifest.json + index.js. */
async function writePlugin(name: string, opts: DirOptions = {}): Promise<string> {
  const dir = path.join(await tmpdir(), name);
  await fsp.mkdir(dir, { recursive: true });
  const indexSource = opts.indexSource ?? INDEX_JS;
  const manifest: Record<string, unknown> = {
    manifest_version: 2,
    name,
    version: "1.0.0",
    nyx: ">=0.1.0",
    capabilities: [],
    integrity: sha256Hex(indexSource),
    ...opts.manifestOverrides,
  };
  if (opts.manifestMutator !== undefined) opts.manifestMutator(manifest);
  await fsp.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await fsp.writeFile(path.join(dir, "index.js"), indexSource);
  return dir;
}

describe("loadPluginDirectory — manifest gate", () => {
  it("rejects a v1 manifest with the migration message", async () => {
    const dir = path.join(await tmpdir(), "legacy");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ name: "legacy", version: "1.0.0", nyx: ">=0.1.0", capabilities: [] }),
    );
    await fsp.writeFile(path.join(dir, "index.js"), INDEX_JS);
    await expect(loadPluginDirectory(dir)).rejects.toMatchObject({
      name: "ManifestValidationError",
      issues: expect.arrayContaining([expect.stringContaining("v1→v2 migration")]),
    });
  });

  it("rejects a directory missing either file with a clear error", async () => {
    const dir = await tmpdir();
    await expect(loadPluginDirectory(dir)).rejects.toMatchObject({
      name: "ManifestValidationError",
    });
  });

  it("rejects an index.js that does not export setup", async () => {
    const dir = await writePlugin("nosetup", { indexSource: "export const x = 1;\n" });
    await expect(loadPluginDirectory(dir, { mode: "warn" })).rejects.toMatchObject({
      name: "ManifestValidationError",
      issues: [expect.stringContaining("setup(kernel)")],
    });
  });
});

describe("loadPluginDirectory — integrity gate", () => {
  it("rejects a tampered index.js in every mode except off", async () => {
    // Manifest declares the hash of the ORIGINAL source; disk carries a
    // backdoored variant.
    const dir = await writePlugin("tampered", {
      manifestOverrides: { integrity: sha256Hex(INDEX_JS) },
      indexSource: INDEX_JS + "// sneaky backdoor\n",
    });
    for (const mode of ["strict", "warn"] as const) {
      await expect(loadPluginDirectory(dir, { mode })).rejects.toMatchObject({
        name: "PluginIntegrityError",
      });
    }
    // off: no check (config-gated to development + explicit flag).
    await expect(loadPluginDirectory(dir, { mode: "off" })).resolves.toBeDefined();
  });
});

describe("loadPluginDirectory — signature gate", () => {
  it("strict: rejects an unsigned plugin", async () => {
    const dir = await writePlugin("unsigned");
    await expect(
      loadPluginDirectory(dir, { mode: "strict", trustedKeys: [] }),
    ).rejects.toMatchObject({
      name: "PluginSignatureError",
      reason: "unsigned",
    });
  });

  it("warn: loads an unsigned plugin with a warning", async () => {
    const dir = await writePlugin("unsigned");
    const warnings: string[] = [];
    const loaded = await loadPluginDirectory(dir, {
      mode: "warn",
      trustedKeys: [],
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(loaded.signature).toEqual({ signed: false, trusted: false, valid: false });
    expect(loaded.warnings.join(" ")).toContain("unsigned");
    expect(warnings).toHaveLength(1);
  });

  it("strict: accepts a validly-signed plugin from a trusted key", async () => {
    const pair = generateSigningKeypair();
    const manifest: PluginManifest = {
      manifest_version: 2,
      name: "signed-ok",
      version: "1.0.0",
      nyx: ">=0.1.0",
      capabilities: [],
      integrity: sha256Hex(INDEX_JS),
    };
    const signature = signManifest(manifest, pair.private_key_pem);
    const dir = await writePlugin("signed-ok", { manifestOverrides: { signature } });
    const loaded = await loadPluginDirectory(dir, {
      mode: "strict",
      trustedKeys: [pair.public_key_hex],
    });
    expect(loaded.signature).toEqual({ signed: true, trusted: true, valid: true });
    expect(loaded.warnings).toEqual([]);
  });

  it("rejects a signed plugin from an UNTRUSTED key even in warn mode", async () => {
    const signerPair = generateSigningKeypair();
    const otherPair = generateSigningKeypair();
    const manifest: PluginManifest = {
      manifest_version: 2,
      name: "unanchored",
      version: "1.0.0",
      nyx: ">=0.1.0",
      capabilities: [],
      integrity: sha256Hex(INDEX_JS),
    };
    const signature = signManifest(manifest, signerPair.private_key_pem);
    const dir = await writePlugin("unanchored", { manifestOverrides: { signature } });
    for (const mode of ["strict", "warn"] as const) {
      await expect(
        loadPluginDirectory(dir, { mode, trustedKeys: [otherPair.public_key_hex] }),
      ).rejects.toMatchObject({ name: "PluginSignatureError", reason: "untrusted_key" });
    }
  });

  it("rejects a tampered manifest body under a valid key (invalid signature)", async () => {
    const pair = generateSigningKeypair();
    const manifest: PluginManifest = {
      manifest_version: 2,
      name: "tampered-manifest",
      version: "1.0.0",
      nyx: ">=0.1.0",
      capabilities: [],
      integrity: sha256Hex(INDEX_JS),
    };
    const signature = signManifest(manifest, pair.private_key_pem);
    // The attacker rewrites the manifest AFTER it was signed.
    const dir = await writePlugin("tampered-manifest", {
      manifestOverrides: { signature, capabilities: ["host.access"] },
    });
    await expect(
      loadPluginDirectory(dir, { mode: "strict", trustedKeys: [pair.public_key_hex] }),
    ).rejects.toMatchObject({ name: "PluginSignatureError", reason: "invalid_signature" });
  });
});

describe("loadPluginDirectory → kernel.use (the runtime path end-to-end)", () => {
  it("a loaded plugin registers its tool through the enforced kernel", async () => {
    const pair = generateSigningKeypair();
    const manifest: PluginManifest = {
      manifest_version: 2,
      name: "hello-plugin",
      version: "1.0.0",
      nyx: ">=0.1.0",
      capabilities: [],
      integrity: sha256Hex(INDEX_JS),
    };
    const signature = signManifest(manifest, pair.private_key_pem);
    const dir = await writePlugin("hello-plugin", { manifestOverrides: { signature } });
    const loaded = await loadPluginDirectory(dir, {
      mode: "strict",
      trustedKeys: [pair.public_key_hex],
    });

    const kernel = createKernel();
    await kernel.use(loaded.plugin);
    expect(kernel.tools.get("hello")).toBeDefined();
    const audit = kernel.list_plugins();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.name).toBe("hello-plugin");
    // The tool actually executes.
    const handler = kernel.tools.get("hello");
    expect(handler).not.toBeNull();
    const out = await handler!.handler.execute({ call_id: "c1", name: "hello", input: {} }, {
      session_id: "s",
      turn_id: "t",
      call_id: "c1",
      signal: new AbortController().signal,
    } as never);
    expect(out).toEqual({ kind: "text", text: "hello from plugin" });
  });
});

describe("resolveSignatureMode", () => {
  it("explicit config wins; default is strict in production, warn in development", () => {
    expect(resolveSignatureMode("strict", "development")).toBe("strict");
    expect(resolveSignatureMode("warn", "production")).toBe("warn");
    expect(resolveSignatureMode(undefined, "production")).toBe("strict");
    expect(resolveSignatureMode(undefined, "development")).toBe("warn");
    expect(resolveSignatureMode(undefined, undefined)).toBe("strict");
  });
});

describe("templates/plugin — the shipped template", () => {
  const TEMPLATE_DIR = path.resolve(import.meta.dirname, "../../../templates/plugin");

  it("the committed manifest's integrity matches its index.js", async () => {
    const manifest = JSON.parse(
      await fsp.readFile(path.join(TEMPLATE_DIR, "manifest.json"), "utf8"),
    ) as PluginManifest;
    const source = await fsp.readFile(path.join(TEMPLATE_DIR, "index.js"), "utf8");
    expect(manifest.integrity).toBe(sha256Hex(source));
    expect(manifest.manifest_version).toBe(2);
  });

  it("loads in warn mode as shipped (unsigned template) and in strict mode once signed", async () => {
    // As shipped: unsigned → warn mode, warning recorded.
    const asShipped = await loadPluginDirectory(TEMPLATE_DIR, {
      mode: "warn",
      trustedKeys: [],
    });
    expect(asShipped.signature.signed).toBe(false);

    // Signed with a generated keypair → strict mode loads it end-to-end
    // (this is the acceptance test from the Phase 7 brief).
    const pair = generateSigningKeypair();
    const manifest: PluginManifest = JSON.parse(
      await fsp.readFile(path.join(TEMPLATE_DIR, "manifest.json"), "utf8"),
    );
    const signature = signManifest(manifest, pair.private_key_pem);
    const signedDir = path.join(await tmpdir(), "signed-template");
    await fsp.cp(TEMPLATE_DIR, signedDir, { recursive: true });
    await fsp.writeFile(
      path.join(signedDir, "manifest.json"),
      JSON.stringify({ ...manifest, signature }, null, 2),
    );
    const loaded = await loadPluginDirectory(signedDir, {
      mode: "strict",
      trustedKeys: [pair.public_key_hex],
    });
    expect(loaded.signature).toEqual({ signed: true, trusted: true, valid: true });
    const kernel = createKernel();
    await kernel.use(loaded.plugin);
    expect(kernel.list_plugins()[0]?.name).toBe(manifest.name);
  });
});

// ── R2-2 (fan-out): integrity pins the WHOLE code directory ────────────────

describe("loadPluginDirectory — sibling code files (R2-2)", () => {
  const HELPER = `export const payload = "original";\n`;
  const INDEX_WITH_HELPER = `import { payload } from "./helper.js";\n` + INDEX_JS;

  async function writeMultiFilePlugin(name: string): Promise<string> {
    const dir = path.join(await tmpdir(), name);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "index.js"), INDEX_WITH_HELPER);
    await fsp.writeFile(path.join(dir, "helper.js"), HELPER);
    await fsp.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify(
        {
          manifest_version: 2,
          name,
          version: "1.0.0",
          nyx: ">=0.1.0",
          capabilities: [],
          integrity: sha256Hex(INDEX_WITH_HELPER),
          files: { "helper.js": sha256Hex(HELPER) },
        },
        null,
        2,
      ),
    );
    return dir;
  }

  it("loads a multi-file plugin whose files map matches the directory", async () => {
    const dir = await writeMultiFilePlugin("multi-ok");
    const loaded = await loadPluginDirectory(dir, { mode: "warn", trustedKeys: [] });
    expect(loaded.signature.signed).toBe(false); // unsigned, warn mode
    expect(loaded.warnings.join(" ")).toContain("unsigned");
  });

  it("rejects a TAMPERED helper.js even though index.js + signature are perfect", async () => {
    const pair = generateSigningKeypair();
    const dir = await writeMultiFilePlugin("multi-tampered");
    // Sign the manifest (covering integrity + files), then tamper helper.js.
    const manifest: PluginManifest = JSON.parse(
      await fsp.readFile(path.join(dir, "manifest.json"), "utf8"),
    );
    const signature = signManifest(manifest, pair.private_key_pem);
    await fsp.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ ...manifest, signature }, null, 2),
    );
    await fsp.writeFile(path.join(dir, "helper.js"), `export const payload = "BACKDOOR";\n`);
    for (const mode of ["strict", "warn"] as const) {
      await expect(
        loadPluginDirectory(dir, { mode, trustedKeys: [pair.public_key_hex] }),
      ).rejects.toMatchObject({ name: "PluginIntegrityError" });
    }
  });

  it("rejects a code file on disk with NO files entry (unlisted sibling)", async () => {
    const dir = await writeMultiFilePlugin("multi-unlisted");
    await fsp.writeFile(path.join(dir, "sneaky.js"), `export const x = 1;\n`);
    await expect(loadPluginDirectory(dir, { mode: "warn" })).rejects.toMatchObject({
      name: "PluginIntegrityError",
      plugin: "multi-unlisted",
    });
  });

  it("rejects a stale manifest entry (declared file absent on disk)", async () => {
    const dir = await writeMultiFilePlugin("multi-stale");
    await fsp.rm(path.join(dir, "helper.js"));
    await expect(loadPluginDirectory(dir, { mode: "warn" })).rejects.toMatchObject({
      name: "PluginIntegrityError",
    });
  });

  it("documentation files are exempt (README.md needs no entry)", async () => {
    const dir = await writeMultiFilePlugin("multi-docs");
    await fsp.writeFile(path.join(dir, "README.md"), "# docs\n");
    await expect(loadPluginDirectory(dir, { mode: "warn" })).resolves.toBeDefined();
  });
});
