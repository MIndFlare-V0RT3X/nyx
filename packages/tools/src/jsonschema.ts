// SPDX-License-Identifier: AGPL-3.0-or-later
// Zod ↔ JSON Schema bridges for tool input schemas.
//
// zodToJsonSchema renders the zod subset the builtins use (object / string /
// number / boolean / optional / default / describe) into the model-facing
// input_schema. Bounds live in the human description, not in machine-checked
// min/max keywords — the zod schema stays the single validation truth.
//
// jsonSchemaToZod goes the other way for NON-builtin tools: their
// ToolDefinition only carries a JsonSchema, so the runtime compiles the
// declared subset (type + properties + required) into a zod schema. Anything
// the converter does not understand degrades to z.unknown() — an
// under-specified schema must never reject a call the tool would have
// accepted. Objects are passthrough: unknown keys reach the handler.

import { z } from "zod";
import type { JsonSchema } from "@nyx/protocol";

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convertZod(schema);
}

function convertZod(schema: z.ZodTypeAny): JsonSchema {
  const out: JsonSchema = {};
  if (schema.description !== undefined && schema.description !== "") {
    out.description = schema.description;
  }

  if (schema instanceof z.ZodObject) {
    out.type = "object";
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(schema.shape) as Array<[string, z.ZodTypeAny]>) {
      properties[key] = convertZod(value);
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
        required.push(key);
      }
    }
    out.properties = properties;
    if (required.length > 0) out.required = required;
    return out;
  }
  if (schema instanceof z.ZodOptional) return convertZod(schema.unwrap());
  if (schema instanceof z.ZodDefault) return convertZod(schema.removeDefault());
  if (schema instanceof z.ZodNullable) return convertZod(schema.unwrap());
  if (schema instanceof z.ZodString) {
    out.type = "string";
    return out;
  }
  if (schema instanceof z.ZodNumber) {
    out.type = schema.isInt ? "integer" : "number";
    return out;
  }
  if (schema instanceof z.ZodBoolean) {
    out.type = "boolean";
    return out;
  }
  if (schema instanceof z.ZodEnum) {
    out.type = "string";
    out.enum = schema.options as unknown[];
    return out;
  }
  if (schema instanceof z.ZodArray) {
    out.type = "array";
    out.items = convertZod(schema.element);
    return out;
  }
  // Anything else (intersections, unions, refinements, effects) is described
  // permissively: an empty schema means "anything" in JSON Schema.
  return out;
}

export function jsonSchemaToZod(schema: JsonSchema): z.ZodTypeAny {
  return convertJson(schema);
}

function convertJson(schema: JsonSchema): z.ZodTypeAny {
  const type = schema.type;
  if (typeof type !== "string") return z.unknown();

  switch (type) {
    case "object": {
      const shape: Record<string, z.ZodTypeAny> = {};
      const properties = schema.properties;
      const required = Array.isArray(schema.required)
        ? schema.required.filter((k): k is string => typeof k === "string")
        : [];
      if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
        for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
          const prop =
            value !== null && typeof value === "object" && !Array.isArray(value)
              ? convertJson(value as JsonSchema)
              : z.unknown();
          shape[key] = required.includes(key) ? prop : prop.optional();
        }
      }
      return z.object(shape).passthrough();
    }
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array": {
      const items = schema.items;
      const inner =
        items !== null && typeof items === "object" && !Array.isArray(items)
          ? convertJson(items as JsonSchema)
          : z.unknown();
      return z.array(inner);
    }
    default:
      return z.unknown();
  }
}
