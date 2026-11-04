// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { cidrContains, isIPLiteral, normalizeHost, parseCidr, parseIPv4, parseIPv6 } from "./ip.js";

describe("parseIPv4", () => {
  it.each([
    ["0.0.0.0", 0n],
    ["10.255.0.1", (10n << 24n) | (255n << 16n) | 1n],
    ["192.168.1.255", (192n << 24n) | (168n << 16n) | (1n << 8n) | 255n],
    ["255.255.255.255", 0xffffffffn],
  ])("parses %s", (input, expected) => {
    expect(parseIPv4(input)).toBe(expected);
  });

  it.each([
    "10.1",
    "10.1.2",
    "1.2.3.4.5",
    "256.1.1.1",
    "a.b.c.d",
    "1..2.3",
    "01.2.3.4", // leading-zero octets are octal-ambiguous: rejected
    "1.2.3.",
    ".1.2.3",
    "-1.2.3.4",
    "",
    " 1.2.3.4",
    "1.2.3.4:80",
  ])("rejects %s", (input) => {
    expect(parseIPv4(input)).toBeNull();
  });
});

describe("parseIPv6", () => {
  it("parses the unspecified and loopback addresses", () => {
    expect(parseIPv6("::")).toBe(0n);
    expect(parseIPv6("::1")).toBe(1n);
    expect(parseIPv6("0:0:0:0:0:0:0:1")).toBe(1n);
  });

  it("parses full and compressed forms to the same value", () => {
    const full = parseIPv6("2001:0db8:0000:0000:0000:0000:0000:0001");
    const compressed = parseIPv6("2001:db8::1");
    expect(full).not.toBeNull();
    expect(full).toBe(compressed);
    expect(full).toBe(0x20010db8000000000000000000000001n);
  });

  it("is case-insensitive", () => {
    expect(parseIPv6("2001:DB8::1")).toBe(parseIPv6("2001:db8::1"));
  });

  it("compresses leading, trailing, and middle zero runs", () => {
    expect(parseIPv6("::2:3")).toBe(parseIPv6("0:0:0:0:0:0:2:3"));
    expect(parseIPv6("1:2::")).toBe(parseIPv6("1:2:0:0:0:0:0:0"));
    expect(parseIPv6("1::2")).toBe(parseIPv6("1:0:0:0:0:0:0:2"));
  });

  it("parses embedded IPv4 tails", () => {
    expect(parseIPv6("::ffff:192.168.0.1")).toBe(0x0000ffffc0a80001n);
    expect(parseIPv6("::ffff:10.0.0.1")).toBe(0x0000ffff0a000001n);
    expect(parseIPv6("::ffff:192.168.0.1")).toBe(parseIPv6("::ffff:c0a8:1"));
    expect(parseIPv6("64:ff9b::1.2.3.4")).toBe(parseIPv6("64:ff9b::102:304"));
    expect(parseIPv6("1:2:3:4:5:6:1.2.3.4")).toBe(parseIPv6("1:2:3:4:5:6:102:304"));
  });

  it.each([
    "1:2:3:4:5:6:7:8:9", // too many groups
    "1:2:3:4:5:6:7", // too few groups without ::
    "1::2::3", // double compression
    ":::",
    ":1:2:3:4:5:6:7", // leading single colon
    "1:2:3:4:5:6:7:", // trailing single colon
    "gg::1", // non-hex
    "12345::", // hextet too long
    "1.2.3.4", // bare IPv4 is not an IPv6 literal
    "1:2:3:4:5:6:7:1.2.3.4", // 7 groups + v4 = 9
    "::ffff:999.1.1.1", // invalid embedded v4
    "1.2::3", // dots outside the trailing v4 group
    "fe80::1%eth0", // zone ids unsupported
    "",
    ":",
  ])("rejects %s", (input) => {
    expect(parseIPv6(input)).toBeNull();
  });
});

describe("isIPLiteral", () => {
  it.each(["10.0.0.1", "255.255.255.255", "::1", "::", "2001:db8::1", "[::1]", "[2001:db8::5]"])(
    "accepts %s",
    (host) => {
      expect(isIPLiteral(host)).toBe(true);
    },
  );

  it.each(["example.com", "app.example.com", "[::1]:8080", "", "1.2.3.4.5"])(
    "rejects %s",
    (host) => {
      expect(isIPLiteral(host)).toBe(false);
    },
  );
});

describe("parseCidr", () => {
  it("parses IPv4 CIDRs within 0-32", () => {
    expect(parseCidr("10.0.0.0/8")).toEqual({ family: 4, bits: 10n << 24n, prefix: 8 });
    expect(parseCidr("0.0.0.0/0")).toEqual({ family: 4, bits: 0n, prefix: 0 });
    expect(parseCidr("10.0.0.1/32")).toEqual({ family: 4, bits: (10n << 24n) | 1n, prefix: 32 });
  });

  it("parses IPv6 CIDRs within 0-128", () => {
    expect(parseCidr("2001:db8::/32")).toEqual({
      family: 6,
      bits: 0x20010db8n << 96n,
      prefix: 32,
    });
    expect(parseCidr("::/0")).toEqual({ family: 6, bits: 0n, prefix: 0 });
  });

  it.each([
    "10.0.0.0/33",
    "10.0.0.0/-1",
    "2001:db8::/129",
    "10.0.0.0", // no prefix
    "10.0.0.0/",
    "/8",
    "banana/8",
    "10.0.0.0/08", // leading-zero prefix rejected
    "10.0.0.0/8/8",
    "",
  ])("rejects %s", (cidr) => {
    expect(parseCidr(cidr)).toBeNull();
  });
});

describe("cidrContains", () => {
  it("checks the IPv4 table from the spec", () => {
    expect(cidrContains("10.0.0.0/8", "10.255.0.1")).toBe(true);
    expect(cidrContains("10.0.0.0/8", "11.0.0.1")).toBe(false);
    expect(cidrContains("10.0.0.1/32", "10.0.0.1")).toBe(true);
    expect(cidrContains("10.0.0.1/32", "10.0.0.2")).toBe(false);
    expect(cidrContains("192.168.1.0/24", "192.168.1.0")).toBe(true); // first address
    expect(cidrContains("192.168.1.0/24", "192.168.1.255")).toBe(true); // last address
    expect(cidrContains("192.168.1.0/24", "192.168.2.0")).toBe(false); // outside
    expect(cidrContains("0.0.0.0/0", "8.8.8.8")).toBe(true); // catch-all
  });

  it("checks the IPv6 table from the spec", () => {
    expect(cidrContains("2001:db8::/32", "2001:db8::1")).toBe(true);
    expect(cidrContains("2001:db8::/32", "2001:db8:ffff::1")).toBe(true);
    expect(cidrContains("2001:db8::/32", "2001:db9::1")).toBe(false);
    expect(cidrContains("::/0", "2001:db8::1")).toBe(true);
    expect(cidrContains("::1/128", "::1")).toBe(true);
    expect(cidrContains("::1/128", "::2")).toBe(false);
  });

  it("matches family only — IPv4 CIDRs never cover IPv6 literals and vice versa", () => {
    expect(cidrContains("10.0.0.0/8", "::ffff:10.0.0.1")).toBe(false);
    expect(cidrContains("2001:db8::/32", "2001:db8.0.0.1")).toBe(false);
  });

  it("contains IPv4-mapped ranges on the v6 side", () => {
    expect(cidrContains("::ffff:0:0/96", "::ffff:10.0.0.1")).toBe(true);
    expect(cidrContains("::ffff:0:0/96", "::1")).toBe(false);
  });

  it("returns false for garbage, never throws", () => {
    expect(cidrContains("banana/8", "10.0.0.1")).toBe(false);
    expect(cidrContains("10.0.0.0/8", "banana")).toBe(false);
    expect(cidrContains("10.0.0.0/8", "")).toBe(false);
  });
});

describe("normalizeHost", () => {
  it.each([
    ["EXAMPLE.com", "example.com"],
    ["example.com.", "example.com"],
    ["  App.Example.COM  ", "app.example.com"],
    ["example.com:443", "example.com"],
    ["example.com:99999", "example.com"],
    ["192.168.1.1:80", "192.168.1.1"],
    ["[::1]", "::1"],
    ["[2001:DB8::5]:8080", "2001:db8::5"],
    ["::1", "::1"], // bare IPv6 survives (multiple colons block port stripping)
    ["2001:db8::1", "2001:db8::1"],
    ["a:b:c", "a:b:c"], // non-numeric port-looking suffix: untouched
    ["host:", "host:"], // empty suffix is not a port
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });
});
