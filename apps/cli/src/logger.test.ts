// SPDX-License-Identifier: AGPL-3.0-or-later
// CLI logger: pino lines with level filtering, child bindings, and substring
// redaction of the config's `redact` list before anything reaches the sink.

import { describe, expect, it } from "vitest";
import { createCliLogger } from "./logger.js";

interface Line {
  level: string;
  msg: string;
  [key: string]: unknown;
}

function capturing(): { lines: Line[]; write(line: string): void } {
  const lines: Line[] = [];
  return { lines, write: (line: string) => lines.push(JSON.parse(line) as Line) };
}

describe("createCliLogger", () => {
  it("emits structured JSON lines with readable level labels", () => {
    const sink = capturing();
    const logger = createCliLogger({ level: "debug", redact: [] }, { sink });
    logger.info("hello", { session_id: "s1" });
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]?.level).toBe("info");
    expect(sink.lines[0]?.msg).toBe("hello");
    expect(sink.lines[0]?.session_id).toBe("s1");
    expect(typeof sink.lines[0]?.time).toBe("number");
  });

  it("filters below the configured level", () => {
    const sink = capturing();
    const logger = createCliLogger({ level: "warn", redact: [] }, { sink });
    logger.debug("nope");
    logger.info("nope");
    logger.warn("yes");
    logger.error("yes");
    expect(sink.lines.map((l) => l.level)).toEqual(["warn", "error"]);
  });

  it("child loggers carry bindings into every line", () => {
    const sink = capturing();
    const logger = createCliLogger({ level: "info", redact: [] }, { sink });
    logger.child({ component: "router" }).info("route.selected", { provider: "mock" });
    expect(sink.lines[0]?.component).toBe("router");
    expect(sink.lines[0]?.provider).toBe("mock");
  });

  it("masks every occurrence of each redact substring, in keys and values", () => {
    const sink = capturing();
    const logger = createCliLogger(
      { level: "info", redact: ["sk-secret123", "tokenterm"] },
      { sink },
    );
    logger.info("provider.call", {
      authorization: "Bearer sk-secret123",
      nested: { api_key: "sk-secret123" },
      tokenterm: "key-name-is-masked-too",
    });
    const raw = JSON.stringify(sink.lines);
    expect(raw).not.toContain("sk-secret123");
    expect(raw).not.toContain("tokenterm");
    expect(raw).toContain("***");
    // values masked in place; the key not carrying a needle survives
    expect(sink.lines[0]?.authorization).toBe("Bearer ***");
    expect(sink.lines[0]?.nested).toEqual({ api_key: "***" });
  });

  it("falls back to info for an unknown level string", () => {
    const sink = capturing();
    const logger = createCliLogger({ level: "bogus" as "info", redact: [] }, { sink });
    logger.info("visible");
    logger.debug("hidden");
    expect(sink.lines).toHaveLength(1);
  });
});
