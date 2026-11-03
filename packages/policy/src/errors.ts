// SPDX-License-Identifier: AGPL-3.0-or-later
// Internal typed-error helper. Codes come from the NyxErrorCode set in
// @nyx/protocol (kept as `string` here so protocol stays the single source).

export class CodedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodedError";
    this.code = code;
  }
}
