// SPDX-License-Identifier: AGPL-3.0-or-later
// DNS-rebinding defense unit tests for the egress resolver.
import { describe, expect, it } from "vitest";
import { DnsEgressResolver } from "./egress.js";
import type { LookupAddress } from "node:dns";

function addr(address: string, family: 4 | 6 = 4): LookupAddress {
  return { address, family };
}

describe("DnsEgressResolver", () => {
  it("pins a resolution for the ttl window (one lookup, identical endpoints)", async () => {
    let clock = 1_000_000;
    let lookups = 0;
    const resolver = new DnsEgressResolver({
      now: () => clock,
      ttl_ms: 30_000,
      lookup: async (_hostname) => {
        lookups += 1;
        return [addr(`10.1.${lookups}.5`)];
      },
    });

    const first = await resolver.resolve("pinned.test", 443);
    clock += 10_000; // still inside the pin window
    const second = await resolver.resolve("PINNED.test", 8443);
    expect(lookups).toBe(1);
    expect(second).toEqual(first); // same endpoint, port carried from first pin
    expect(second.ips).toEqual([{ address: "10.1.1.5", family: 4 }]);
    expect(second.pinned_until).toBe(1_000_000 + 30_000);

    clock += 25_000; // past pinned_until → fresh resolution required
    const third = await resolver.resolve("pinned.test", 443);
    expect(lookups).toBe(2);
    expect(third.ips).toEqual([{ address: "10.1.2.5", family: 4 }]);
    expect(third.pinned_until).toBe(clock + 30_000);
  });

  it("returns every address the lookup yields (v4 + v6)", async () => {
    const resolver = new DnsEgressResolver({
      lookup: async () => [addr("127.0.0.1", 4), addr("::1", 6)],
    });
    const ep = await resolver.resolve("dual.test", 80);
    expect(ep.ips).toEqual([
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ]);
    expect(ep.hostname).toBe("dual.test");
  });

  it("numeric hosts pass through without DNS (IP literals never resolve)", async () => {
    let lookups = 0;
    const resolver = new DnsEgressResolver({
      lookup: async (h) => {
        lookups += 1;
        return [addr(h)];
      },
    });
    const ep = await resolver.resolve("127.0.0.1", 8080);
    expect(ep.ips).toEqual([{ address: "127.0.0.1", family: 4 }]);
    expect(lookups).toBe(1); // the injected lookup is getaddrinfo — numerics stay local to it
  });

  it("empty resolution is an error, never an implicit allow", async () => {
    const resolver = new DnsEgressResolver({ lookup: async () => [] });
    await expect(resolver.resolve("void.test", 80)).rejects.toThrow(/no addresses/);
  });
});
