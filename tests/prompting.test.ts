import { describe, expect, it } from 'vitest';
import {
  estimateTextTokens,
} from '../src/runtime/context/helpers/token-budget.helper.js';
import {
  buildDurableRuntimeStatePrompt,
  buildStableEnvironmentContext,
  createJobPromptManifest,
  JOB_AGENT_PROMPT_ID,
  JOB_AGENT_PROMPT_VERSION,
  JOB_AGENT_SYSTEM_PROMPT,
} from '../src/runtime/prompting/job-agent-prompt.js';

describe('prompt governance', () => {
  it('requires bounded complete writes and sequential chunked file writes', () => {
    expect(JOB_AGENT_SYSTEM_PROMPT).toContain(
      'write_file and write_article each write one complete file within their declared character and token limits'
    );
    expect(JOB_AGENT_SYSTEM_PROMPT).toContain(
      'call start_file_write once with the intended code/, docs/, or artifacts/ path, then append_file_chunk once per model turn'
    );
    expect(JOB_AGENT_SYSTEM_PROMPT).toContain(
      'Do not rewrite a successful file merely because you speculate that its content was truncated'
    );
  });

  it('produces deterministic component manifests and isolates dynamic state', () => {
    const stableContext = buildStableEnvironmentContext({
      sandboxRoot: '/tmp/agent-sandbox',
      sessionId: 'session_1',
    });
    const first = createJobPromptManifest({
      systemPrompt: JOB_AGENT_SYSTEM_PROMPT,
      promptId: JOB_AGENT_PROMPT_ID,
      promptVersion: JOB_AGENT_PROMPT_VERSION,
      stableContext,
      runtimeStateMessages: ['state-v1'],
    });
    const repeated = createJobPromptManifest({
      systemPrompt: JOB_AGENT_SYSTEM_PROMPT,
      promptId: JOB_AGENT_PROMPT_ID,
      promptVersion: JOB_AGENT_PROMPT_VERSION,
      stableContext,
      runtimeStateMessages: ['state-v1'],
    });
    const changedState = createJobPromptManifest({
      systemPrompt: JOB_AGENT_SYSTEM_PROMPT,
      promptId: JOB_AGENT_PROMPT_ID,
      promptVersion: JOB_AGENT_PROMPT_VERSION,
      stableContext,
      runtimeStateMessages: ['state-v2'],
    });

    expect(repeated).toEqual(first);
    expect(changedState.checksum).not.toBe(first.checksum);
    expect(changedState.components.slice(0, 2)).toEqual(first.components.slice(0, 2));
    expect(first.components.map(component => component.cacheScope))
      .toEqual(['stable', 'stable', 'dynamic']);
  });

  it('bounds a large durable Runtime State while retaining an authoritative envelope', () => {
    const text = buildDurableRuntimeStatePrompt({
      job: { id: 'job_1', status: 'running' },
      plan: {
        id: 'plan_1',
        steps: Array.from({ length: 20 }, (_, index) => ({
          key: `step_${index}`,
          status: 'completed',
          result: { summary: 'x'.repeat(5_000) },
        })),
      },
      artifacts: Array.from({ length: 100 }, (_, index) => ({
        id: `artifact_${index}`,
        logicalPath: `artifacts/${'long-name-'.repeat(20)}${index}.md`,
      })),
    }, 500);

    expect(text).toContain('Durable runtime state (authoritative, schemaVersion=1)');
    expect(estimateTextTokens(text)).toBeLessThanOrEqual(500);
  });
});
