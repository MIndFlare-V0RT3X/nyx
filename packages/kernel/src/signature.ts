// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 7.2 — plugin signature primitives.
//
// Ed25519 over the canonical manifest JSON (the `signature` field removed,
// everything else canonicalized by @nyx/protocol's canonicalJson — sorted
// keys at every depth, arrays in order, undefined dropped). The public key
// is hex (32 bytes); the signature is hex (64 bytes).
//
// Trust anchor: the operator's trusted-keys.json ({ "keys": ["<hex>", …] }),
// populated by hand, empty by default. A signed plugin whose key is absent
// is rejected EVEN IN WARN MODE — a signature is an anchor claim, and an
// unanchored claim is worth less than no signature at all (it implies a
// trust relationship that does not exist).

import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { promises as fsp } from "node:fs";
import { canonicalJson, type PluginManifest } from "@nyx/protocol";

/** sha256 of the bytes, hex-encoded — the manifest `integrity` value. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The canonical string a manifest is signed over: JSON with `signature` gone. */
export function canonicalManifestForSigning(manifest: PluginManifest): string {
  const { signature: _signature, ...rest } = manifest;
  return canonicalJson(rest);
}

/** Hex Ed25519 public key → KeyObject (via JWK; Node has no raw-ingest). */
function publicKeyFromHex(hex: string): ReturnType<typeof createPublicKey> {
  const raw = Buffer.from(hex, "hex");
  if (raw.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes (64 hex chars), got ${raw.length}`);
  }
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

export interface GeneratedKeypair {
  /** PEM-encoded private key — operator keeps it, never commits it. */
  private_key_pem: string;
  /** Hex-encoded public key — goes into trusted-keys.json and the manifest. */
  public_key_hex: string;
}

/** Generate a fresh Ed25519 keypair for plugin signing. */
export function generateSigningKeypair(): GeneratedKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Raw public key bytes via JWK export ('x' is base64url of the 32 bytes).
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (typeof jwk.x !== "string") throw new Error("public key export produced no JWK 'x'");
  return {
    private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    public_key_hex: Buffer.from(jwk.x, "base64url").toString("hex"),
  };
}

/** Sign a manifest with a PEM private key; returns the manifest `signature` block. */
export function signManifest(
  manifest: PluginManifest,
  privateKeyPem: string,
): { public_key: string; signature: string } {
  // The public key must be embedded so verifiers can match it against their
  // trusted set — derive it from the private key.
  const { publicKey } = createKeyPairFromPrivatePem(privateKeyPem);
  const payload = Buffer.from(canonicalManifestForSigning(manifest), "utf8");
  const signatureHex = sign(null, payload, privateKeyPem).toString("hex");
  return { public_key: publicKey, signature: signatureHex };
}

function createKeyPairFromPrivatePem(privateKeyPem: string): { publicKey: string } {
  // Derive the public key from the private PEM via createPublicKey.
  const pub = createPublicKey(privateKeyPem);
  const jwk = pub.export({ format: "jwk" }) as { x?: string };
  if (typeof jwk.x !== "string") throw new Error("could not derive public key from private PEM");
  return { publicKey: Buffer.from(jwk.x, "base64url").toString("hex") };
}

export type SignatureCheck =
  | { signed: false }
  | {
      signed: true;
      /** true iff the embedded public key is in the trusted set. */
      trusted: boolean;
      /** true iff the Ed25519 signature verifies. */
      valid: boolean;
    };

/** Structural signature check against a set of trusted hex public keys. */
export function checkManifestSignature(
  manifest: PluginManifest,
  trustedKeys: readonly string[],
): SignatureCheck {
  const signature = manifest.signature;
  if (signature === undefined) return { signed: false };
  const trusted = trustedKeys.includes(signature.public_key);
  let valid = false;
  try {
    const key = publicKeyFromHex(signature.public_key);
    const payload = Buffer.from(canonicalManifestForSigning(manifest), "utf8");
    valid = verify(null, payload, key, Buffer.from(signature.signature, "hex"));
  } catch {
    valid = false;
  }
  return { signed: true, trusted, valid };
}

export interface TrustedKeysFile {
  keys: string[];
}

/**
 * Read the operator's trust anchor. A MISSING file is an empty trust set
 * (nothing is trusted); a MALFORMED file is a hard error — an operator who
 * cannot parse their own trust file should not load third-party plugins
 * against a guess.
 */
export async function loadTrustedKeys(file: string): Promise<TrustedKeysFile> {
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ENOENT") return { keys: [] };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `trusted-keys file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const candidate = parsed as { keys?: unknown };
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray(candidate.keys) ||
    !candidate.keys.every((k) => typeof k === "string" && /^[0-9a-f]{64}$/.test(k))
  ) {
    throw new Error(
      `trusted-keys file ${file} must be { "keys": ["<64-hex Ed25519 public key>", …] }`,
    );
  }
  return { keys: candidate.keys as string[] };
}
