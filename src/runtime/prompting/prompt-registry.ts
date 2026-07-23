import { createHash } from 'node:crypto';
import type {
  AgentPromptComponentManifest,
  AgentPromptManifest,
} from '../../domain/index.js';
import { estimateTextTokens } from '../context/token-budget.js';

export interface PromptComponentInput {
  id: string;
  version: number;
  cacheScope: 'stable' | 'dynamic';
  text: string;
}

export function createPromptManifest(input: {
  id: string;
  version: number;
  components: PromptComponentInput[];
}): AgentPromptManifest {
  const components = input.components.map(component => ({
    id: component.id,
    version: component.version,
    cacheScope: component.cacheScope,
    checksum: sha256(component.text),
    estimatedTokens: estimateTextTokens(component.text),
  } satisfies AgentPromptComponentManifest));
  return {
    id: input.id,
    version: input.version,
    checksum: sha256(canonicalJson(components)),
    components,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
