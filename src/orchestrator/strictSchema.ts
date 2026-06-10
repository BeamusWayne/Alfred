/**
 * Strict JSON-schema conversion for native structured outputs.
 *
 * Providers' strict modes share two constraints beyond plain JSON Schema:
 *   - every object must declare `additionalProperties: false`;
 *   - (OpenAI) every declared property must be listed in `required`.
 *
 * `toStrictJsonSchema` deep-clones the zod-emitted schema, enforces the
 * first, and returns null when the second cannot hold (an optional property
 * exists) — callers then keep the synthetic structured_output tool instead
 * of risking a provider 400 mid-run.
 */

export function toStrictJsonSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> | null {
  const root = structuredClone(schema);
  delete root.$schema;
  return strictifyNode(root) ? root : null;
}

function strictifyNode(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(strictifyNode);
  if (node === null || typeof node !== "object") return true;
  const n = node as Record<string, unknown>;
  if (n.type === "object" || n.properties !== undefined) {
    n.additionalProperties = false;
    const props = (n.properties ?? {}) as Record<string, unknown>;
    const required = Array.isArray(n.required) ? (n.required as readonly unknown[]) : [];
    for (const key of Object.keys(props)) {
      if (!required.includes(key)) return false;
    }
  }
  return Object.values(n).every(strictifyNode);
}
