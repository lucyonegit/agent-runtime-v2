/**
 * Produces a deterministic JSON representation by sorting object keys.
 *
 * This is used for persisted checksums and idempotency identities. Changing
 * its output is a storage compatibility change, not a formatting refactor.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
