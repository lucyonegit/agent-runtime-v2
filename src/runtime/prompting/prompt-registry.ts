import { createHash } from 'node:crypto';
import type {
  AgentPromptComponentManifest,
  AgentPromptManifest,
} from '../../domain/index.js';
import { estimateTextTokens } from '../context/helpers/token-budget.helper.js';
import { stableStringify } from '../helpers/stable-json.helper.js';

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
    checksum: sha256(stableStringify(components)),
    components,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
