import { isToolMessage } from '@langchain/core/messages';
import type { AgentArtifactDraft } from '../../../domain/index.js';
import type { ToolExecutionResult } from '../../loop/agent-loop.js';
import type { RuntimeUserInputArtifact } from '../tool-executor.js';

export function normalizeToolOutput(output: unknown): ToolExecutionResult {
  if (isToolMessage(output)) {
    if (isUserInputArtifact(output.artifact)) {
      return { type: 'requires_user_input', request: output.artifact.request };
    }
    return {
      type: 'completed',
      content: output.text,
      result: output.artifact ?? output.content,
      artifacts: readArtifactDrafts(output.artifact),
    };
  }
  return {
    type: 'completed',
    content: stringifyToolOutput(output),
    result: output,
  };
}

function isUserInputArtifact(value: unknown): value is RuntimeUserInputArtifact {
  return Boolean(value && typeof value === 'object'
    && (value as { type?: unknown }).type === 'requires_user_input'
    && (value as { request?: unknown }).request);
}

function stringifyToolOutput(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function readArtifactDrafts(value: unknown): AgentArtifactDraft[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidates = (value as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(candidates)) return undefined;
  const artifacts = candidates.filter(isArtifactDraft);
  return artifacts.length > 0 ? artifacts : undefined;
}

function isArtifactDraft(value: unknown): value is AgentArtifactDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<AgentArtifactDraft>;
  return draft.kind === 'file'
    && ['code', 'docs', 'artifacts', 'downloads'].includes(String(draft.area))
    && [draft.title, draft.fileName, draft.logicalPath, draft.storagePath,
      draft.mediaType, draft.checksum].every(
      item => typeof item === 'string' && item.length > 0
    )
    && typeof draft.size === 'number'
    && Number.isSafeInteger(draft.size)
    && draft.size >= 0;
}
