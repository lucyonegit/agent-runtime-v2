export function redactToolArguments(
  arguments_: Record<string, unknown>,
  sensitivePaths: string[]
): Record<string, unknown> {
  if (sensitivePaths.length === 0) return arguments_;
  const copy = structuredClone(arguments_);
  for (const path of sensitivePaths) {
    const segments = path.startsWith('/')
      ? path.slice(1).split('/').map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
      : path.split('.');
    let owner: unknown = copy;
    for (let index = 0; index < segments.length - 1; index += 1) {
      if (!owner || typeof owner !== 'object') break;
      owner = (owner as Record<string, unknown>)[segments[index]!];
    }
    const key = segments.at(-1);
    if (key && owner && typeof owner === 'object' && key in owner) {
      (owner as Record<string, unknown>)[key] = '[REDACTED]';
    }
  }
  return copy;
}
