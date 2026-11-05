// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 7.2 — Ed25519 plugin signature primitives.

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PluginManifest } from "@nyx/protocol";
import {
  canonicalManifestForSigning,
  checkManifestSignature,
  generateSigningKeypair,
  loadTrustedKeys,
  sha256Hex,
  signManifest,
} from "./signature.js";

const INTEGRITY = "1".repeat(64);

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    manifest_version: 2,
    name: "signed-plugin",
    version: "1.0.0",
    nyx: ">=0.1.0",
    capabilities: ["fs.read"],
    integrity: INTEGRITY,
    ...overrides,
  };
}

const tmpDirs: string[] = [];
async function tmpdir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-sig-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of tmpDirs) await fsp.rm(dir, { recursive: true, force: true });
});

describe("generateSigningKeypair", () => {
  it("produces a PEM private key and a 64-hex public key", () => {
    const pair = generateSigningKeypair();
    expect(pair.private_key_pem).toContain("BEGIN PRIVATE KEY");
    expect(pair.public_key_hex).toMatch(/^[0-9a-f]{64}$/);
    // Fresh keys are fresh.
    expect(generateSigningKeypair().public_key_hex).not.toBe(pair.public_key_hex);
  });
});

describe("sha256Hex", () => {
  it("matches node's digest", () => {
    expect(sha256Hex("hello")).toBe(createHash("sha256").update("hello").digest("hex"));
    expect(sha256Hex(new Uint8Array([1, 2, 3]))).toBe(
      createHash("sha256")
        .update(Buffer.from([1, 2, 3]))
        .digest("hex"),
    );
  });
});

describe("canonicalManifestForSigning", () => {
  it("excludes the signature field and canonicalizes (sorted keys)", () => {
    const m = manifest();
    const text = canonicalManifestForSigning(m);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.signature).toBeUndefined();
    // canonicalJson sorts keys: "capabilities" precedes "integrity"…
    expect(text.indexOf('"capabilities"')).toBeLessThan(text.indexOf('"integrity"'));
    // …and the round trip preserves every other field.
    expect(parsed.name).toBe("signed-plugin");
    expect(parsed.manifest_version).toBe(2);
  });
});

describe("signManifest + checkManifestSignature", () => {
  it("accepts a validly-signed manifest from a trusted key", () => {
    const pair = generateSigningKeypair();
    const signature = signManifest(manifest(), pair.private_key_pem);
    expect(signature.public_key).toBe(pair.public_key_hex);
    const signed = manifest({ signature });
    const check = checkManifestSignature(signed, [pair.public_key_hex]);
    expect(check).toEqual({ signed: true, trusted: true, valid: true });
  });

  it("rejects a tampered manifest (signature over different content)", () => {
    const pair = generateSigningKeypair();
    const signature = signManifest(manifest(), pair.private_key_pem);
    // Tamper AFTER signing: the attacker changed the capabilities.
    const tampered = manifest({ capabilities: ["host.access"], signature });
    const check = checkManifestSignature(tampered, [pair.public_key_hex]);
    expect(check).toEqual({ signed: true, trusted: true, valid: false });
  });

  it("reports an untrusted key", () => {
    const pair = generateSigningKeypair();
    const otherPair = generateSigningKeypair();
    const signature = signManifest(manifest(), pair.private_key_pem);
    const signed = manifest({ signature });
    const check = checkManifestSignature(signed, [otherPair.public_key_hex]);
    expect(check).toEqual({ signed: true, trusted: false, valid: true });
  });

  it("reports unsigned manifests as { signed: false }", () => {
    expect(checkManifestSignature(manifest(), [])).toEqual({ signed: false });
  });

  it("survives malformed hex instead of throwing", () => {
    const bogus = manifest({
      signature: { public_key: "zz".repeat(32), signature: "ff".repeat(64) },
    });
    const check = checkManifestSignature(bogus, []);
    expect(check.signed).toBe(true);
    if (check.signed) {
      expect(check.trusted).toBe(false);
      expect(check.valid).toBe(false);
    }
  });
});

describe("loadTrustedKeys", () => {
  it("returns an empty set for a missing file (nothing is trusted by default)", async () => {
    const dir = await tmpdir();
    expect(await loadTrustedKeys(path.join(dir, "absent.json"))).toEqual({ keys: [] });
  });

  it("loads a well-formed file", async () => {
    const dir = await tmpdir();
    const file = path.join(dir, "trusted-keys.json");
    await fsp.writeFile(file, JSON.stringify({ keys: ["a".repeat(64), "b".repeat(64)] }));
    expect((await loadTrustedKeys(file)).keys).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  it("refuses a malformed file (bad JSON, wrong shape, bad key hex)", async () => {
    const dir = await tmpdir();
    const badJson = path.join(dir, "bad-json.json");
    await fsp.writeFile(badJson, "{not json");
    await expect(loadTrustedKeys(badJson)).rejects.toThrow(/not valid JSON/);
    const badShape = path.join(dir, "bad-shape.json");
    await fsp.writeFile(badShape, JSON.stringify({ keys: "not-a-list" }));
    await expect(loadTrustedKeys(badShape)).rejects.toThrow(/must be/);
    const badHex = path.join(dir, "bad-hex.json");
    await fsp.writeFile(badHex, JSON.stringify({ keys: ["nothex"] }));
    await expect(loadTrustedKeys(badHex)).rejects.toThrow(/must be/);
  });
});
