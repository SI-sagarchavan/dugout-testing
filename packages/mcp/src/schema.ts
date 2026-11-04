import { z } from "zod";

/** How deep a ref that leads back into itself is followed before the rest is left open. */
const MAX_DEPTH = 4;

/** The value at a local JSON Pointer (`#/properties/a/items`), or undefined. */
function at(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith("#")) return undefined;
  let node = root;
  for (const raw of pointer.slice(1).split("/").filter(Boolean)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * The schema with every local `$ref` replaced by what it points to. Servers write schemas that
 * point into themselves (zod-to-json-schema reuses a repeated sub-schema by JSON Pointer), which
 * zod's converter does not follow. A ref that leads back into itself is followed `MAX_DEPTH` times;
 * below that, any value is accepted.
 */
export function inlineRefs(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (node: unknown, trail: string[]): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, trail));
    if (node === null || typeof node !== "object") return node;
    const object = node as Record<string, unknown>;
    if (typeof object.$ref === "string") {
      const ref = object.$ref;
      const seen = trail.filter((t) => t === ref).length;
      const target = at(schema, ref);
      if (target === undefined)
        throw new Error(`the schema points to ${ref}, which it does not have`);
      if (seen >= MAX_DEPTH) return {};
      const { $ref: _, ...rest } = object;
      return walk({ ...(target as Record<string, unknown>), ...rest }, [...trail, ref]);
    }
    return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, walk(v, trail)]));
  };
  return walk(schema, []) as Record<string, unknown>;
}

/** A tool's JSON Schema as the zod input the `Tool` contract takes, local refs inlined. */
export function zodOf(schema: Record<string, unknown>): z.ZodType<Record<string, unknown>> {
  return z.fromJSONSchema(inlineRefs(schema) as never) as z.ZodType<Record<string, unknown>>;
}
