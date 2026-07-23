import { resolve } from 'node:path';
import type { AgentPromptManifest } from '../../domain/index.js';
import { estimateTextTokens } from '../context/token-budget.js';
import { createPromptManifest } from './prompt-registry.js';

export const JOB_AGENT_PROMPT_ID = 'job-agent';
export const JOB_AGENT_PROMPT_VERSION = 7;
export const JOB_AGENT_SYSTEM_PROMPT_VERSION =
  `${JOB_AGENT_PROMPT_ID}-v${JOB_AGENT_PROMPT_VERSION}`;
export const JOB_AGENT_POLICY_COMPONENT_ID = 'job-agent-policy';
export const JOB_AGENT_ENVIRONMENT_COMPONENT_ID = 'job-agent-environment';
export const JOB_AGENT_ENVIRONMENT_COMPONENT_VERSION = 1;
export const RUNTIME_STATE_COMPONENT_ID = 'durable-runtime-state';
export const RUNTIME_STATE_COMPONENT_VERSION = 1;
export const RUNTIME_STATE_SCHEMA_VERSION = 1;
export const RUNTIME_STATE_MAX_TOKENS = 8_000;

export const JOB_AGENT_SYSTEM_PROMPT = `You are a reliable tool-using agent. Complete the user's actual goal and report only outcomes that are durably verified.

Planning:
- Handle simple, local, or single-action requests directly.
- Use update_plan for multi-step work that benefits from explicit progress or checkpoints.
- Keep the durable plan synchronized with actual execution.
- Do not return a final answer while the durable plan has unfinished steps.
- Mark a step failed only when its goal is unrecoverable. Revise or retry recoverable work.

Execution:
- Tool calls in one response are siblings and cannot observe each other.
- Execute prerequisite searches, reads, or inspections first. Perform dependent writes or publishing in a later model turn.
- Follow each tool's schema and local usage contract.
- write_file and write_article each write one complete file within their declared character and token limits. Prefer splitting large implementations into cohesive modules instead of creating oversized files.
- Never truncate a file to satisfy a complete-write limit. For one indivisible large file or document, call start_file_write once with the intended code/, docs/, or artifacts/ path, then append_file_chunk once per model turn with the exact nextChunkIndex, and finalize only the last chunk.
- A successful file ToolMessage is authoritative. Do not rewrite a successful file merely because you speculate that its content was truncated.
- Treat ToolMessages and durable runtime state as authoritative facts.
- Never invent completed work, artifacts, evidence IDs, paths, checksums, or persisted results.
- Never expose secrets or terminate arbitrary operating-system processes.

Conversation and evidence:
- When the user asks about an earlier run, explain the history without re-executing it unless explicitly asked to retry, continue, rerun, or recreate it.
- Search snippets are discovery aids. Open relevant sources before making source-dependent claims.
- Report only work that has actually completed and artifacts that actually exist.`;

export function buildStableEnvironmentContext(input: {
  sandboxRoot: string;
  sessionId: string;
}): string {
  const workspaceRoot = resolve(
    input.sandboxRoot,
    'sessions',
    input.sessionId,
    'workspace'
  );
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return [
    'Stable execution environment:',
    `- Session workspace root: ${workspaceRoot}`,
    '- Workspace areas: code/, docs/, artifacts/, downloads/, tmp/.',
    '- Use workspace-relative paths with file and artifact tools unless a tool explicitly permits absolute paths.',
    `- Host platform: ${process.platform}/${process.arch}. Default shell: /bin/zsh. Time zone: ${timeZone}.`,
    '- Current wall-clock time is intentionally not embedded in this stable prefix; use the time tool when exact current time is required.',
  ].join('\n');
}

export function createJobPromptManifest(input: {
  systemPrompt: string;
  promptId: string;
  promptVersion: number;
  stableContext?: string;
  runtimeStateMessages?: string[];
}): AgentPromptManifest {
  return createPromptManifest({
    id: input.promptId,
    version: input.promptVersion,
    components: [
      {
        id: JOB_AGENT_POLICY_COMPONENT_ID,
        version: input.promptVersion,
        cacheScope: 'stable',
        text: input.systemPrompt,
      },
      ...(input.stableContext ? [{
        id: JOB_AGENT_ENVIRONMENT_COMPONENT_ID,
        version: JOB_AGENT_ENVIRONMENT_COMPONENT_VERSION,
        cacheScope: 'stable' as const,
        text: input.stableContext,
      }] : []),
      ...(input.runtimeStateMessages ?? []).map(text => ({
        id: RUNTIME_STATE_COMPONENT_ID,
        version: RUNTIME_STATE_COMPONENT_VERSION,
        cacheScope: 'dynamic' as const,
        text,
      })),
    ],
  });
}

export function buildDurableRuntimeStatePrompt(
  state: Record<string, unknown>,
  maxTokens = RUNTIME_STATE_MAX_TOKENS
): string {
  let projected = state;
  let text = formatRuntimeState(projected);
  if (estimateTextTokens(text) <= maxTokens) return text;

  const sourceArtifacts = Array.isArray(state.artifacts) ? state.artifacts : [];
  let artifactLimit = Math.min(sourceArtifacts.length, 50);
  while (artifactLimit > 0 && estimateTextTokens(text) > maxTokens) {
    artifactLimit = Math.floor(artifactLimit / 2);
    projected = {
      ...state,
      artifacts: artifactLimit === 0 ? [] : sourceArtifacts.slice(-artifactLimit),
      artifactProjection: {
        total: sourceArtifacts.length,
        included: artifactLimit,
        omitted: sourceArtifacts.length - artifactLimit,
      },
    };
    text = formatRuntimeState(projected);
  }
  if (estimateTextTokens(text) <= maxTokens) return text;

  projected = projectPlanDetails(projected);
  text = formatRuntimeState(projected);
  if (estimateTextTokens(text) <= maxTokens) return text;

  const serialized = JSON.stringify(projected);
  let previewCharacters = Math.max(128, maxTokens * 3);
  do {
    text = [
      `Durable runtime state (authoritative, schemaVersion=${RUNTIME_STATE_SCHEMA_VERSION}):`,
      JSON.stringify({
        projectionTruncated: true,
        preview: serialized.slice(0, previewCharacters),
        originalCharacterCount: serialized.length,
      }),
    ].join('\n');
    previewCharacters = Math.floor(previewCharacters / 2);
  } while (estimateTextTokens(text) > maxTokens && previewCharacters >= 64);
  return text;
}

function formatRuntimeState(state: Record<string, unknown>): string {
  return [
    `Durable runtime state (authoritative, schemaVersion=${RUNTIME_STATE_SCHEMA_VERSION}):`,
    JSON.stringify(state),
  ].join('\n');
}

function projectPlanDetails(state: Record<string, unknown>): Record<string, unknown> {
  const plan = state.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return state;
  const planRecord = plan as Record<string, unknown>;
  const steps = Array.isArray(planRecord.steps)
    ? planRecord.steps.map(step => {
        if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
        const { result, error, ...identity } = step as Record<string, unknown>;
        return {
          ...identity,
          ...(result === undefined ? {} : { result: projectDetail(result) }),
          ...(error === undefined ? {} : { error: projectDetail(error) }),
        };
      })
    : planRecord.steps;
  return {
    ...state,
    plan: {
      ...planRecord,
      steps,
      detailProjection: 'Step result and error values are bounded previews.',
    },
  };
}

function projectDetail(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length <= 1_000) return value;
  return {
    truncated: true,
    preview: serialized.slice(0, 1_000),
    originalCharacterCount: serialized.length,
  };
}
