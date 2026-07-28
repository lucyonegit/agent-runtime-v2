export const AGENT_REQUEST_LIMITS = {
  sessionTitleCharacters: 200,
  taskMessageCharacters: 100_000,
  idempotencyKeyCharacters: 200,
  userInputTextCharacters: 100_000,
} as const;

export function assertAgentRequestText(
  value: unknown,
  field: string,
  maximumCharacters: number,
  options: { optional?: boolean } = {}
): asserts value is string | undefined {
  if (value === undefined && options.optional) return;
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string.`);
  if (!options.optional && !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  if (value.length > maximumCharacters) {
    throw new RangeError(`${field} must not exceed ${maximumCharacters} characters.`);
  }
}
