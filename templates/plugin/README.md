# The NYX plugin template

Copy this directory to build a third-party plugin. The trust model is
deliberately simple:

## The trust model

```
your machine                     the operator's machine
─────────────                    ──────────────────────
plugin-signing-key.pem   ──┐
 (Ed25519 private, 0600)   │  signs the canonical manifest
                           ▼
                    manifest.json { signature }
                    index.js      (sha256 = manifest.integrity)
                           │
                           ▼  verify: integrity + signature + trusted key
                    trusted-keys.json { keys: [public key hex] }
                           │
                           ▼
                    kernel.use(plugin) — capability-enforced
```

Three claims must all hold before the plugin's code is ever imported:

1. **Integrity** — the manifest's `integrity` is the sha256 of `index.js`.
   Change the code, re-sign, or be rejected.
2. **Signature** — the manifest is Ed25519-signed over its canonical JSON
   (the `signature` block removed, keys sorted). Any value change after
   signing invalidates it.
3. **Trust anchor** — the signing key's public half must appear in the
   operator's `trusted-keys.json` (config: `plugins.trusted_keys_file`,
   default `~/.nyx/plugins/trusted-keys.json`, **empty by default — nothing
   is trusted until the operator says so**).

A plugin signed by a key that is *not* in the trust file is rejected in
**every** mode, including `warn`: a signature from an unanchored key implies
a trust relationship that does not exist, and that is worse than an honest
unsigned plugin (which at least surfaces as "unsigned" in warn mode).

## Signature modes

| mode | unsigned plugin | signed + trusted + valid | signed but untrusted/invalid |
|---|---|---|---|
| `strict` (production default) | rejected | loads | rejected |
| `warn` (development default) | loads with a warning | loads | rejected |
| `off` | loads | loads | loads — **requires `NYX_ENV=development` AND the `--allow-unsigned-plugins` CLI flag**; any other combination fails config validation |

## Build a plugin

```sh
# 1. Copy the template
cp -r templates/plugin ~/.nyx/plugins/my-plugin
cd ~/.nyx/plugins/my-plugin

# 2. Edit index.js (your tools) and manifest.json
#    (name, version, capabilities — declare exactly what you use)

# 3. Generate a signing keypair (once)
node /path/to/nyx/templates/plugin/scripts/generate-keypair.mjs ~/.nyx
# → prints the public key hex; private key lands at ~/.nyx/plugin-signing-key.pem

# 4. Put the public key in your trusted-keys.json
echo '{ "keys": ["<public key hex>"] }' > ~/.nyx/plugins/trusted-keys.json

# 5. Sign (refreshes integrity against the current index.js)
node /path/to/nyx/templates/plugin/scripts/sign-manifest.mjs \
  ~/.nyx/plugins/my-plugin ~/.nyx/plugin-signing-key.pem

# 6. Audit it
nyx plugin audit ~/.nyx/plugins/my-plugin
```

## Manifest v2 reference

```json
{
  "manifest_version": 2,
  "name": "example-plugin",
  "version": "0.1.0",
  "nyx": ">=0.1.0",
  "capabilities": [],
  "dependencies": [{ "name": "other-plugin", "version_range": ">=1.0.0" }],
  "integrity": "<sha256 hex of index.js>",
  "signature": { "public_key": "<hex>", "signature": "<hex>" },
  "tools": ["example-hello"]
}
```

- `capabilities` — declare what your tools exercise. A tool registering
  `net.egress` under a manifest without `net.egress` throws `CapabilityError`
  at load time. Declaring capabilities you never use surfaces as a warning in
  `kernel.list_plugins()` and `nyx plugin audit` — over-declaration weakens
  the audit trail, trim it.
- `dependencies` — objects with `version_range`s; the loaded dependency's
  version must satisfy the range or the plugin refuses to load.
- `nyx` — the kernel API semver range you built against.

## What a plugin can never do

- Call `kernel.use()` or `kernel.unuse()` — the plugin set is host-only
  mutable (`PluginMutationError`). A plugin cannot load itself again, load
  collaborators, or unload a neighbor to hijack its tool names.
- Register a tool whose capabilities exceed the manifest (`CapabilityError`).
- Overwrite a tool owned by the host or another plugin (`ToolOwnershipError`).
- Set services outside its `plugin:<name>:` namespace (`ServiceNamespaceError`).
- Lie about its manifest — the loader takes the manifest from `manifest.json`
  on disk and the kernel re-validates it.

## index.js contract

Export `setup(kernel)` (required) and optionally `teardown()`. `setup` runs
inside your enforcement context; register tools and hooks there. On unuse or
kernel close, everything you registered is removed for you.
