// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 7.2 — `nyx plugin audit`: the static trust audit.

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateSigningKeypair, sha256Hex, signManifest } from "@nyx/kernel";
import type { PluginManifest } from "@nyx/protocol";
import { pluginAudit, renderPluginAudit } from "./plugin.js";

const INDEX_JS = `export async function setup(kernel) {
  kernel.tools.register({
    name: "demo",
    description: "demo tool",
    input_schema: { type: "object", properties: {} },
    risk: "R0",
    capabilities: [],
    handler: "plugin:demo/demo",
  }, { execute: async () => ({ kind: "text", text: "ok" }) });
}
`;

const tmpDirs: string[] = [];
async function tmpdir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-plugin-audit-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of tmpDirs) await fsp.rm(dir, { recursive: true, force: true });
});

interface WriteOpts {
  manifestOverrides?: Record<string, unknown>;
  indexSource?: string;
}

async function writePlugin(
  name: string,
  opts: WriteOpts = {},
): Promise<string> {
  const dir = path.join(await tmpdir(), name);
  await fsp.mkdir(dir, { recursive: true });
  const indexSource = opts.indexSource ?? INDEX_JS;
  const manifest = {
    manifest_version: 2,
    name,
    version: "1.0.0",
    nyx: ">=0.1.0",
    capabilities: [],
    integrity: sha256Hex(indexSource),
    ...opts.manifestOverrides,
  };
  await fsp.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await fsp.writeFile(path.join(dir, "index.js"), indexSource);
  return dir;
}

function checkNamed(
  report: { checks: { name: string; status: string; detail: string }[] },
  name: string,
) {
  const check = report.checks.find((c) => c.name === name);
  expect(check, `check "${name}" present`).toBeDefined();
  return check!;
}

describe("pluginAudit", () => {
  it("passes a validly-signed plugin with the key in the trust file", async () => {
    const pair = generateSigningKeypair();
    const keysFile = path.join(await tmpdir(), "trusted-keys.json");
    await fsp.writeFile(keysFile, JSON.stringify({ keys: [pair.public_key_hex] }));
    const base: PluginManifest = {
      manifest_version: 2,
      name: "good",
      version: "1.0.0",
      nyx: ">=0.1.0",
      capabilities: ["fs.read"],
      integrity: sha256Hex(INDEX_JS),
    };
    const dir = await writePlugin("good", {
      manifestOverrides: {
        ...base,
        signature: signManifest(base, pair.private_key_pem),
      },
    });
    const report = await pluginAudit(dir, { trusted_keys_file: keysFile, env: {} });
    expect(report.exit_code).toBe(0);
    expect(report.checks.every((c) => c.status !== "fail")).toBe(true);
    expect(checkNamed(report, "signature").status).toBe("ok");
    expect(renderPluginAudit(dir, report)).toContain("[  ok ] signature:");
  });

  it("warns (strict: fails) on an unsigned plugin", async () => {
    const dir = await writePlugin("unsigned");
    const keysFile = path.join(await tmpdir(), "trusted-keys.json");
    await fsp.writeFile(keysFile, JSON.stringify({ keys: [] }));
    // warn mode → warning only
    const warnReport = await pluginAudit(dir, {
      trusted_keys_file: keysFile,
      env: {},
      configured_mode: "warn",
    });
    expect(warnReport.exit_code).toBe(0);
    expect(checkNamed(warnReport, "signature").status).toBe("warn");
    // strict mode (default in production) → failure
    const strictReport = await pluginAudit(dir, {
      trusted_keys_file: keysFile,
      env: { NYX_ENV: "production" },
    });
    expect(strictReport.exit_code).toBe(1);
    expect(checkNamed(strictReport, "signature").status).toBe("fail");
  });

  it("fails on a tampered index.js (integrity mismatch)", async () => {
    // The manifest carries the hash of the ORIGINAL source; disk has a
    // backdoored variant.
    const dir = await writePlugin("tampered", {
      indexSource: INDEX_JS + "// backdoor\n",
      manifestOverrides: { integrity: sha256Hex(INDEX_JS) },
    });
    const keysFile = path.join(await tmpdir(), "trusted-keys.json");
    await fsp.writeFile(keysFile, JSON.stringify({ keys: [] }));
    const report = await pluginAudit(dir, { trusted_keys_file: keysFile, env: {} });
    expect(report.exit_code).toBe(1);
    expect(checkNamed(report, "integrity").status).toBe("fail");
  });

  it("fails a signed plugin whose key is not in the trust file (every mode)", async () => {
    const signer = generateSigningKeypair();
    const someone = generateSigningKeypair();
    const keysFile = path.join(await tmpdir(), "trusted-keys.json");
    await fsp.writeFile(keysFile, JSON.stringify({ keys: [someone.public_key_hex] }));
    const base: PluginManifest = {
      manifest_version: 2,
      name: "unanchored",
      version: "1.0.0",
      nyx: ">=0.1.0",
      capabilities: [],
      integrity: sha256Hex(INDEX_JS),
    };
    const dir = await writePlugin("unanchored", {
      manifestOverrides: { ...base, signature: signManifest(base, signer.private_key_pem) },
    });
    for (const configured of ["warn", undefined] as const) {
      const report = await pluginAudit(dir, {
        trusted_keys_file: keysFile,
        env: {},
        ...(configured !== undefined ? { configured_mode: configured } : {}),
      });
      expect(report.exit_code).toBe(1);
      expect(checkNamed(report, "signature").status).toBe("fail");
    }
  });

  it("fails a v1 manifest with the migration guidance", async () => {
    const dir = path.join(await tmpdir(), "v1");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ name: "v1", version: "1.0.0", nyx: ">=0.1.0", capabilities: [] }),
    );
    await fsp.writeFile(path.join(dir, "index.js"), INDEX_JS);
    const report = await pluginAudit(dir, { env: {} });
    expect(report.exit_code).toBe(1);
    expect(checkNamed(report, "manifest").detail).toContain("manifest_version");
  });

  it("fails a missing directory with a clear error", async () => {
    const report = await pluginAudit(path.join(await tmpdir(), "absent"), { env: {} });
    expect(report.exit_code).toBe(1);
    expect(checkNamed(report, "files").status).toBe("fail");
  });

  it("reports the effective signature mode from NYX_ENV", async () => {
    const dir = await writePlugin("modecheck");
    const keysFile = path.join(await tmpdir(), "trusted-keys.json");
    await fsp.writeFile(keysFile, JSON.stringify({ keys: [] }));
    const prod = await pluginAudit(dir, { trusted_keys_file: keysFile, env: { NYX_ENV: "production" } });
    expect(checkNamed(prod, "signature mode").detail).toContain('"strict"');
    const dev = await pluginAudit(dir, { trusted_keys_file: keysFile, env: { NYX_ENV: "development" } });
    expect(checkNamed(dev, "signature mode").detail).toContain('"warn"');
  });
});
