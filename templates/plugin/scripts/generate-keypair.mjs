#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Generate an Ed25519 signing keypair for NYX plugins.
//
//   node templates/plugin/scripts/generate-keypair.mjs [output-dir]
//
// Writes <output-dir>/plugin-signing-key.pem (0600) and prints the public
// key hex. Put the public key in your trusted-keys.json:
//
//   { "keys": ["<public key hex>"] }
//
// The private key never leaves your machine; the public key goes wherever
// you want trust to flow from.

import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";

const outDir = process.argv[2] ?? ".";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwk = publicKey.export({ format: "jwk" });
const publicKeyHex = Buffer.from(jwk.x, "base64url").toString("hex");
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });

await mkdir(outDir, { recursive: true });
const keyFile = path.join(outDir, "plugin-signing-key.pem");
await writeFile(keyFile, privateKeyPem, { mode: 0o600 });
await chmod(keyFile, 0o600);

console.log(`private key: ${keyFile} (keep secret, 0600)`);
console.log(`public key:  ${publicKeyHex}`);
console.log(`\nAdd the public key to trusted-keys.json:`);
console.log(`  { "keys": ["${publicKeyHex}"] }`);
