// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { jsonSchemaToZod, zodToJsonSchema } from "./jsonschema.js";
import {
  fsListInput,
  fsReadInput,
  fsWriteInput,
  shellExecInput,
  webFetchInput,
} from "./schemas.js";

describe("zodToJsonSchema", () => {
  it("renders fs.read: object with required string path", () => {
    const schema = zodToJsonSchema(fsReadInput);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["path"]);
    expect((schema.properties as Record<string, { type?: string }>).path?.type).toBe("string");
    expect(typeof schema.description).toBe("undefined");
  });

  it("renders fs.list: path optional (default not in required)", () => {
    const schema = zodToJsonSchema(fsListInput);
    expect(schema.type).toBe("object");
    expect(schema.required).toBeUndefined();
    expect((schema.properties as Record<string, { type?: string }>).path?.type).toBe("string");
  });

  it("renders fs.write with two required fields and carries descriptions", () => {
    const schema = zodToJsonSchema(fsWriteInput);
    expect(schema.required).toEqual(["path", "content"]);
    const props = schema.properties as Record<string, { type?: string; description?: string }>;
    expect(props.path?.type).toBe("string");
    expect(props.content?.type).toBe("string");
    expect(props.content?.description).toContain("UTF-8");
  });

  it("renders shell.exec and web.fetch with optionals typed integer", () => {
    for (const schema of [zodToJsonSchema(shellExecInput), zodToJsonSchema(webFetchInput)]) {
      expect(schema.type).toBe("object");
      const props = schema.properties as Record<string, { type?: string }>;
      expect(Object.values(props).every((p) => p.type === "string" || p.type === "integer")).toBe(
        true,
      );
    }
    expect(zodToJsonSchema(shellExecInput).required).toEqual(["cmd"]);
    expect(zodToJsonSchema(webFetchInput).required).toEqual(["url"]);
  });
});

describe("jsonSchemaToZod", () => {
  it("accepts what the builtin schemas accept and rejects what they reject (round trip)", () => {
    for (const original of [
      fsReadInput,
      fsListInput,
      fsWriteInput,
      shellExecInput,
      webFetchInput,
    ]) {
      const roundTripped = jsonSchemaToZod(zodToJsonSchema(original));
      expect(roundTripped.safeParse({ path: "a.txt" }).success).toBe(
        original.safeParse({ path: "a.txt" }).success,
      );
      expect(roundTripped.safeParse({ path: 42 }).success).toBe(false);
      expect(roundTripped.safeParse("not an object").success).toBe(false);
    }
  });

  it("enforces required fields from the declared schema", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { path: { type: "string" }, note: { type: "string" } },
      required: ["path"],
    });
    expect(schema.safeParse({ note: "hi" }).success).toBe(false);
    expect(schema.safeParse({ path: "hi" }).success).toBe(true);
    expect(schema.safeParse({ path: "hi", note: "x" }).success).toBe(true);
  });

  it("is passthrough: unknown keys survive validation (non-builtin handlers see them)", () => {
    const schema = jsonSchemaToZod({ type: "object", properties: { a: { type: "string" } } });
    const parsed = schema.safeParse({ a: "x", extra: { deep: true } });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>).extra).toEqual({ deep: true });
    }
  });

  it("degrades to z.unknown() for empty or unrecognized schemas", () => {
    expect(jsonSchemaToZod({}).safeParse("anything").success).toBe(true);
    expect(jsonSchemaToZod({}).safeParse(42).success).toBe(true);
    expect(jsonSchemaToZod({ type: "weird" }).safeParse(null).success).toBe(true);
    expect(jsonSchemaToZod({ type: "boolean" }).safeParse(false).success).toBe(true);
    expect(jsonSchemaToZod({ type: "boolean" }).safeParse("no").success).toBe(false);
  });
});
