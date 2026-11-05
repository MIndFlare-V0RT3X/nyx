#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Sign a plugin manifest (Phase 7.2 manifest v2).
//
//   node templates/plugin/scripts/sign-manifest.mjs <plugin-dir> <private-key.pem>
//
// Reads <plugin-dir>/manifest.json, refreshes its `integrity` field against
// the CURRENT index.js, signs the canonical manifest with your Ed25519 key,
// and writes the manifest back with the `signature` block added. Print-only
// mode: `--dry-run` shows the block without writing.
//
// The canonical form is @nyx/protocol's canonicalJson over the manifest with
// `signature` removed — sorted keys at every depth, arrays in order. The
// kernel verifies exactly this string, so hand-editing the JSON afterwards
// (even reordering keys is fine, changing VALUES is not) invalidates the
// signature — which is the point.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash, createPublicKey, sign } from "node:crypto";
import path from "node:path";

// canonicalJson, mirrored from @nyx/protocol (sorted keys, arrays in order,
// undefined dropped). Kept inline so the script has zero imports beyond node.
function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

const [,, dirArg, keyArg, ...rest] = process.argv;
const dryRun = rest.includes("--dry-run");
if (typeof dirArg !== "string" || typeof keyArg !== "string") {
  console.error("usage: sign-manifest.mjs <plugin-dir> <private-key.pem> [--dry-run]");
  process.exit(1);
}

const manifestFile = path.join(dirArg, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
const indexSource = readFileSync(path.join(dirArg, "index.js"), "utf8");

// Refresh integrity against the current code, then sign.
manifest.integrity = createHash("sha256").update(indexSource).digest("hex");

const { signature: _omit, ...unsigned } = manifest;
const payload = canonicalJson(unsigned);
const signatureHex = sign(null, Buffer.from(payload, "utf8"), keyArg).toString("hex");
const publicKeyHex = (() => {
  const jwk = createPublicKey(keyArg).export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url").toString("hex");
})();

manifest.signature = { public_key: publicKeyHex, signature: signatureHex };

const out = JSON.stringify(manifest, null, 2) + "\n";
if (dryRun) {
  console.log(out);
  console.log(`# signature over ${Buffer.byteLength(payload)} canonical bytes`);
} else {
  writeFileSync(manifestFile, out);
  console.log(`signed ${manifestFile}`);
  console.log(`  integrity  ${manifest.integrity.slice(0, 16)}…`);
  console.log(`  public key ${publicKeyHex.slice(0, 16)}…`);
}
