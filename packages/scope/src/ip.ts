// SPDX-License-Identifier: AGPL-3.0-or-later
// IP/CIDR primitives for the scope engine. Pure, hand-rolled BigInt math:
// no node:dns, no netmask deps. Strict parsers: anything ambiguous is null.

/** Parsed CIDR block. `bits` is the network address as written (host bits are not zeroed). */
export interface CidrInfo {
  family: 4 | 6;
  bits: bigint;
  prefix: number;
}

const HEX_GROUP = /^[0-9a-f]{1,4}$/;
// Dotted-quad octet: "0"-"255", no leading zeros ("01" is rejected — it is
// octal-ambiguous under inet_aton and we refuse the ambiguity).
const OCTET = /^(0|[1-9]\d{0,2})$/;
const PREFIX = /^(0|[1-9]\d{0,2})$/;

export function parseIPv4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!OCTET.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

export function parseIPv6(s: string): bigint | null {
  const str = s.toLowerCase();
  // Only hex digits, colons, and dots (dots only ever legal inside the
  // trailing embedded-IPv4 group, enforced below) are acceptable.
  for (const ch of str) {
    const ok = (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || ch === ":" || ch === ".";
    if (!ok) return null;
  }

  const dbl = str.indexOf("::");
  if (dbl !== -1 && str.indexOf("::", dbl + 1) !== -1) return null;

  let head: string[];
  let tail: string[];
  if (dbl === -1) {
    head = str.split(":");
    tail = [];
  } else {
    const headStr = str.slice(0, dbl);
    const tailStr = str.slice(dbl + 2);
    head = headStr === "" ? [] : headStr.split(":");
    tail = tailStr === "" ? [] : tailStr.split(":");
  }

  // An embedded IPv4 part is only legal as the very last group of the last section.
  // With "::" the last section is the tail; without it, the single section is the head.
  const headGroups = parseGroups(head, dbl === -1);
  if (headGroups === null) return null;
  const tailGroups = parseGroups(tail, true);
  if (tailGroups === null) return null;

  const total = headGroups.length + tailGroups.length;
  if (dbl === -1) {
    if (total !== 8) return null;
  } else {
    // "::" stands for one or more zero groups, so at most 7 groups may be explicit.
    if (total > 7) return null;
  }

  const groups =
    dbl === -1
      ? headGroups
      : [...headGroups, ...new Array<bigint>(8 - total).fill(0n), ...tailGroups];

  let value = 0n;
  for (const g of groups) value = (value << 16n) | g;
  return value;
}

function parseGroups(parts: string[], allowV4Tail: boolean): bigint[] | null {
  const out: bigint[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) return null;
    if (part.includes(".")) {
      if (!allowV4Tail || i !== parts.length - 1) return null;
      const v4 = parseIPv4(part);
      if (v4 === null) return null;
      out.push(v4 >> 16n, v4 & 0xffffn);
    } else {
      if (!HEX_GROUP.test(part)) return null;
      out.push(BigInt(`0x${part}`));
    }
  }
  return out;
}

/**
 * True for a bare IP literal ("10.0.0.1", "::1"). Tolerates a fully
 * bracketed IPv6 literal ("[::1]") but NOT bracket-plus-port ("[::1]:80") —
 * run normalizeHost first for URL-style authorities.
 */
export function isIPLiteral(host: string): boolean {
  let h = host.trim();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return parseIPv4(h) !== null || parseIPv6(h) !== null;
}

export function parseCidr(cidr: string): CidrInfo | null {
  const slash = cidr.indexOf("/");
  if (slash === -1 || cidr.indexOf("/", slash + 1) !== -1) return null;
  const base = cidr.slice(0, slash);
  const prefixStr = cidr.slice(slash + 1);
  if (!PREFIX.test(prefixStr)) return null;
  const prefix = Number(prefixStr);

  const v4 = parseIPv4(base);
  if (v4 !== null) return prefix <= 32 ? { family: 4, bits: v4, prefix } : null;
  const v6 = parseIPv6(base);
  if (v6 !== null) return prefix <= 128 ? { family: 6, bits: v6, prefix } : null;
  return null;
}

function masked(bits: bigint, prefix: number, family: 4 | 6): bigint {
  const width = family === 4 ? 32n : 128n;
  if (prefix === 0) return 0n;
  const p = BigInt(prefix);
  return bits & (((1n << p) - 1n) << (width - p));
}

/** Containment check. Same family only — an IPv4 CIDR never covers an IPv6 literal (and vice versa). */
export function cidrContains(cidr: string, ip: string): boolean {
  const c = parseCidr(cidr);
  if (!c) return false;
  const asV4 = parseIPv4(ip);
  if (asV4 !== null) {
    return c.family === 4 && masked(c.bits, c.prefix, 4) === masked(asV4, c.prefix, 4);
  }
  const asV6 = parseIPv6(ip);
  if (asV6 !== null) {
    return c.family === 6 && masked(c.bits, c.prefix, 6) === masked(asV6, c.prefix, 6);
  }
  return false;
}

/**
 * Canonicalize a host for scope checks: trim, lowercase, unwrap bracketed
 * IPv6 (dropping any ":port" after the bracket), strip a ":port" suffix only
 * when the host part contains exactly one colon and the suffix is all digits
 * (so bare "2001:db8::1" survives), and drop one trailing dot.
 */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    if (close > 0) {
      h = h.slice(1, close);
      return h.length > 1 && h.endsWith(".") ? h.slice(0, -1) : h;
    }
  }
  const colon = h.lastIndexOf(":");
  if (colon !== -1) {
    const prefix = h.slice(0, colon);
    const suffix = h.slice(colon + 1);
    if (!prefix.includes(":") && /^\d+$/.test(suffix)) h = prefix;
  }
  if (h.length > 1 && h.endsWith(".")) h = h.slice(0, -1);
  return h;
}
