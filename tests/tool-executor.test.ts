import { DynamicStructuredTool } from '@langchain/core/tools';
import { describe, expect, it, vi } from 'vitest';
import type { AgentToolCall } from '../src/domain/index.js';
import {
  RuntimeToolExecutionError,
  ToolExecutor,
  type RuntimeTool,
} from '../src/runtime/execution/tool-executor.js';
import { checksumToolArguments } from '../src/runtime/execution/helpers/tool-call-identity.helper.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('ToolExecutor failure certainty', () => {
  it('treats a returned RuntimeToolExecutionError as a known failure', async () => {
    const result = await executeWith(async () => {
      throw new RuntimeToolExecutionError(
        'shell_timeout',
        'The command timed out and was terminated.',
        { timedOut: true, signal: 'SIGTERM' }
      );
    });

    expect(result).toEqual({
      type: 'failed',
      executionStarted: true,
      outcomeUnknown: false,
      code: 'shell_timeout',
      message: 'The command timed out and was terminated.',
      details: { timedOut: true, signal: 'SIGTERM' },
    });
  });

  it('marks an unexpected exception after invocation as outcome unknown', async () => {
    const result = await executeWith(async () => {
      throw new Error('connection disappeared');
    });

    expect(result).toMatchObject({
      type: 'failed',
      executionStarted: true,
      outcomeUnknown: true,
      code: 'tool_failed',
      message: 'connection disappeared',
    });
  });
});

async function executeWith(func: () => Promise<never>) {
  const call = { id: 'model_tool_call_1', name: 'side_effect', args: {} };
  const toolCall: AgentToolCall = {
    id: 'tool_call_1',
    sessionId: 'session_1',
    taskId: 'task_1',
    createdInTaskRunId: 'task_run_1',
    callMessageId: 'message_call_1',
    modelToolCallId: call.id,
    toolName: call.name,
    arguments: call.args,
    argumentsChecksum: checksumToolArguments(call.args),
    sideEffectLevel: 'side_effecting',
    idempotencyKey: 'idempotency_1',
    status: 'running',
    version: 2,
    createdAtMs: 1,
    startedAtMs: 2,
    updatedAtMs: 2,
  };
  const runtimeTool: RuntimeTool = {
    tool: new DynamicStructuredTool({
      name: call.name,
      description: 'Test side effect.',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      } as const,
      func,
    }),
    sideEffectLevel: 'side_effecting',
  };
  const startToolCall = vi.fn(async () => ({ started: true, toolCall }));
  const executor = new ToolExecutor({
    store: { execution: { startToolCall } } as unknown as AgentStore,
    workerId: 'worker_1',
    tools: [runtimeTool],
  });

  return executor.execute({
    call,
    definition: runtimeTool.tool,
    target: {
      sessionId: 'session_1',
      taskId: 'task_1',
      taskRunId: 'task_run_1',
    },
  });
}
