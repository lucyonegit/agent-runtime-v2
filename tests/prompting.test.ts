import { describe, expect, it } from 'vitest';
import {
  buildStableEnvironmentContext,
  createTaskPromptManifest,
  TASK_AGENT_PROMPT_ID,
  TASK_AGENT_PROMPT_VERSION,
  TASK_AGENT_SYSTEM_PROMPT,
} from '../src/runtime/prompting/task-agent-prompt.js';

describe('Task ReAct prompt', () => {
  it('treats update_plan as guidance instead of a completion gate', () => {
    expect(TASK_AGENT_SYSTEM_PROMPT).toContain('Use update_plan');
    expect(TASK_AGENT_SYSTEM_PROMPT).toContain('is not a completion gate');
    expect(TASK_AGENT_SYSTEM_PROMPT).toContain('User-visible progress');
    expect(TASK_AGENT_SYSTEM_PROMPT).toContain(
      'Never call update_plan with empty assistant content'
    );
    expect(TASK_AGENT_SYSTEM_PROMPT).toContain('ToolMessages and durable runtime state as authoritative facts');
    expect(TASK_AGENT_SYSTEM_PROMPT).toContain('Unknown side-effect outcomes');
    expect(TASK_AGENT_SYSTEM_PROMPT).toContain('you MUST call request_user_input before continuing');
    expect(TASK_AGENT_SYSTEM_PROMPT).toContain('do not ask the same question again');
    expect(TASK_AGENT_SYSTEM_PROMPT).toContain('not a recovered ToolResult');
  });

  it('keeps the cacheable environment prefix stable and versioned', () => {
    const stable = buildStableEnvironmentContext({
      sandboxRoot: '/tmp/runtime',
      sessionId: 'session_1',
      shellPath: '/bin/zsh',
    });
    expect(stable).toContain('/tmp/runtime/sessions/session_1/workspace');
    expect(stable).not.toContain(new Date().toISOString());
    const manifest = createTaskPromptManifest({
      systemPrompt: TASK_AGENT_SYSTEM_PROMPT,
      promptId: TASK_AGENT_PROMPT_ID,
      promptVersion: TASK_AGENT_PROMPT_VERSION,
      stableContext: stable,
    });
    expect(TASK_AGENT_PROMPT_VERSION).toBe(10);
    expect(manifest.components.map(component => component.cacheScope)).toEqual(['stable', 'stable']);
  });
});
