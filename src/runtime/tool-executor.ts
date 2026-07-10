import type { AgentToolInvocation } from '../domain/index.js';
import {
  FatalToolExecutionError,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolExecutorPort,
} from '../agent-loop/agent-loop.js';
import type { AgentToolDefinition } from '../agent-loop/model-port.js';
import type { AgentStore } from '../storage/agent-store.js';
import { mapStoreError } from './runtime-errors.js';

export interface RuntimeToolContext {
  sessionId: string;
  jobId: string;
  stepRunId?: string;
  attemptId: string;
  toolInvocationId: string;
  toolCallId: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface RuntimeTool {
  definition: AgentToolDefinition;
  execute(
    arguments_: Record<string, unknown>,
    context: RuntimeToolContext
  ): Promise<ToolExecutionResult>;
}

export interface ToolExecutorOptions {
  store: AgentStore;
  workerId: string;
  tools: RuntimeTool[];
  clock?: { nowMs(): number };
}

export class ToolExecutor implements ToolExecutorPort {
  readonly #store: AgentStore;
  readonly #workerId: string;
  readonly #tools: Map<string, RuntimeTool>;
  readonly #clock: { nowMs(): number };

  constructor(options: ToolExecutorOptions) {
    this.#store = options.store;
    this.#workerId = options.workerId;
    this.#tools = new Map(options.tools.map(tool => [tool.definition.name, tool]));
    if (this.#tools.size !== options.tools.length) {
      throw new TypeError('Runtime tool names must be unique.');
    }
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
  }

  definitions(): AgentToolDefinition[] {
    return [...this.#tools.values()].map(tool => tool.definition);
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    let claim;
    try {
      claim = await this.#store.claimToolInvocation({
        jobId: request.target.jobId,
        toolCallId: request.call.id,
        workerId: this.#workerId,
        attemptId: request.target.attemptId,
        nowMs: this.#clock.nowMs(),
      });
    } catch (error) {
      const runtimeError = mapStoreError(error);
      throw new FatalToolExecutionError(runtimeError.code, runtimeError.message, {
        cause: runtimeError,
      });
    }

    if (!claim.claimed) return this.#replayTerminalResult(claim.invocation);
    const invocation = claim.invocation;
    const tool = this.#tools.get(request.call.name);
    if (!tool) {
      return {
        type: 'failed',
        code: 'tool_not_found',
        message: `Tool not found: ${request.call.name}`,
      };
    }
    if (
      invocation.toolName !== request.call.name
      || invocation.argumentsChecksum.length === 0
      || invocation.sideEffectLevel !== tool.definition.sideEffectLevel
    ) {
      throw new FatalToolExecutionError(
        'storage_error',
        `Claimed ToolInvocation ${JSON.stringify(invocation.id)} does not match the runtime tool contract.`
      );
    }

    try {
      return await tool.execute(request.call.args, {
        sessionId: request.target.sessionId,
        jobId: request.target.jobId,
        stepRunId: request.target.stepRunId,
        attemptId: request.target.attemptId,
        toolInvocationId: invocation.id,
        toolCallId: invocation.toolCallId,
        idempotencyKey: invocation.idempotencyKey,
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal?.aborted || isAbortError(error)) throw error;
      return {
        type: 'failed',
        code: 'tool_failed',
        message: error instanceof Error ? error.message : 'Tool execution failed.',
      };
    }
  }

  async #replayTerminalResult(invocation: AgentToolInvocation): Promise<ToolExecutionResult> {
    if (!invocation.resultMessageId) {
      return {
        type: 'failed',
        code: 'tool_failed',
        message: `Tool invocation is ${invocation.status} without a committed result message.`,
      };
    }
    const messages = await this.#store.listSessionMessages(invocation.sessionId);
    const message = messages.find(candidate => candidate.id === invocation.resultMessageId);
    if (!message?.toolResult) {
      throw new FatalToolExecutionError(
        'storage_error',
        `Committed result message ${JSON.stringify(invocation.resultMessageId)} was not found.`
      );
    }
    if (message.toolResult.status === 'failed') {
      return {
        type: 'failed',
        code: invocation.error?.code ?? 'tool_failed',
        message: message.toolResult.error ?? invocation.error?.message ?? 'Tool failed.',
        details: invocation.error?.details,
      };
    }
    return {
      type: 'completed',
      content: message.content,
      result: message.toolResult.result,
    };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
