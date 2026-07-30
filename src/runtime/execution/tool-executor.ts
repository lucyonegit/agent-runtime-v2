import {
  ToolInputParsingException,
  type StructuredToolInterface,
} from '@langchain/core/tools';
import { resolve } from 'node:path';
import type {
  AgentToolSideEffectLevel,
} from '../../domain/index.js';
import type { ToolUserInputRequest } from '../loop/loop-events.js';
import {
  FatalToolExecutionError,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolExecutorPort,
} from '../loop/agent-loop.js';
import type { AgentStore } from '../../storage/agent-store.js';
import type { RuntimeEventPublisher } from '../events/runtime-event-publisher.js';
import { mapStoreError } from '../errors/runtime-error.js';
import { checksumToolArguments } from './helpers/tool-call-identity.helper.js';
import { ToolResultLoader } from './tool-pipeline/tool-result-loader.js';
import { validateToolInput } from './tool-pipeline/tool-input-validator.js';
import { normalizeToolOutput } from './tool-pipeline/tool-result-normalizer.js';

export interface RuntimeToolContext {
  sessionId: string;
  taskId: string;
  sandboxRoot: string;
  taskRunId: string;
  toolCallId: string;
  modelToolCallId: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface RuntimeTool {
  tool: StructuredToolInterface;
  sideEffectLevel: AgentToolSideEffectLevel;
  /** task is used by temporary control tools such as update_plan. */
  contextScope?: 'conversation' | 'task';
  exclusive?: boolean;
  /**
   * This tool must be chosen after the model has observed the results from
   * earlier calls. It cannot safely share one model-produced batch with
   * searches, reads, or any other operation whose result may affect its input.
   */
  requiresFreshContext?: boolean;
  sensitiveArgumentPaths?: string[];
  argumentLimits?: RuntimeToolArgumentLimit[];
}

export interface RuntimeToolArgumentLimit {
  path: string;
  maxCharacters?: number;
  maxEstimatedTokens?: number;
  errorCode: string;
  message: string;
}

export interface RuntimeUserInputArtifact {
  type: 'requires_user_input';
  request: ToolUserInputRequest;
}

/** A recoverable tool failure with a stable code and structured diagnostics. */
export class RuntimeToolExecutionError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly executionStarted: boolean;

  constructor(
    code: string,
    message: string,
    details?: unknown,
    options: { executionStarted?: boolean } = {}
  ) {
    super(message);
    this.name = 'RuntimeToolExecutionError';
    this.code = code;
    this.details = details;
    this.executionStarted = options.executionStarted ?? true;
  }
}

export interface ToolExecutorOptions {
  store: AgentStore;
  workerId: string;
  tools: RuntimeTool[];
  sandboxRoot?: string;
  publisher?: RuntimeEventPublisher;
  clock?: { nowMs(): number };
}

export class ToolExecutor implements ToolExecutorPort {
  readonly #store: AgentStore;
  readonly #workerId: string;
  readonly #tools: Map<string, RuntimeTool>;
  readonly #sandboxRoot: string;
  readonly #clock: { nowMs(): number };
  readonly #publisher?: RuntimeEventPublisher;
  readonly #results: ToolResultLoader;

  constructor(options: ToolExecutorOptions) {
    this.#store = options.store;
    this.#workerId = options.workerId;
    this.#tools = new Map(options.tools.map(tool => [tool.tool.name, tool]));
    if (this.#tools.size !== options.tools.length) {
      throw new TypeError('Runtime tool names must be unique.');
    }
    this.#sandboxRoot = resolve(options.sandboxRoot ?? '.agent-sandbox');
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#publisher = options.publisher;
    this.#results = new ToolResultLoader(options.store);
  }

  tools(): StructuredToolInterface[] {
    return [...this.#tools.values()].map(tool => tool.tool);
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    let startResult;
    try {
      startResult = await this.#store.execution.startToolCall({
        taskId: request.target.taskId,
        taskRunId: request.target.taskRunId,
        modelToolCallId: request.call.id,
        ownerId: this.#workerId,
        nowMs: this.#clock.nowMs(),
      });
    } catch (error) {
      const runtimeError = mapStoreError(error);
      throw new FatalToolExecutionError(runtimeError.code, runtimeError.message, {
        cause: runtimeError,
      });
    }

    if (!startResult.started) return this.#results.load(startResult.toolCall);
    const toolCall = startResult.toolCall;
    await this.#publish({
      type: 'tool_call.upserted',
      sessionId: toolCall.sessionId,
      toolCall,
    });
    const runtimeTool = this.#tools.get(request.call.name);
    if (!runtimeTool) {
      return {
        type: 'failed',
        code: 'tool_not_found',
        message: `Tool not found: ${request.call.name}`,
        executionStarted: false,
      };
    }
    if (
      toolCall.toolName !== request.call.name
      || toolCall.argumentsChecksum !== checksumToolArguments(request.call.args)
      || toolCall.sideEffectLevel !== runtimeTool.sideEffectLevel
    ) {
      throw new FatalToolExecutionError(
        'storage_error',
        `Started ToolCall ${JSON.stringify(toolCall.id)} does not match the runtime tool contract.`
      );
    }
    const argumentLimitFailure = validateToolInput(
      request.call.args,
      runtimeTool.argumentLimits
    );
    if (argumentLimitFailure) return { ...argumentLimitFailure, executionStarted: false };

    const context: RuntimeToolContext = {
      sessionId: request.target.sessionId,
      taskId: request.target.taskId,
      sandboxRoot: this.#sandboxRoot,
      taskRunId: request.target.taskRunId,
      toolCallId: toolCall.id,
      modelToolCallId: toolCall.modelToolCallId,
      idempotencyKey: toolCall.idempotencyKey,
      signal: request.signal,
    };
    try {
      const output = await runtimeTool.tool.invoke({
        ...request.call,
        type: 'tool_call',
      }, {
        signal: request.signal,
        configurable: { agentRuntimeContext: context },
      });
      return normalizeToolOutput(output);
    } catch (error) {
      if (request.signal?.aborted || isAbortError(error)) throw error;
      return {
        type: 'failed',
        executionStarted: error instanceof ToolInputParsingException
          ? false
          : error instanceof RuntimeToolExecutionError
            ? error.executionStarted
            : true,
        code: error instanceof ToolInputParsingException
          ? 'invalid_tool_arguments'
          : error instanceof RuntimeToolExecutionError
            ? error.code
            : 'tool_failed',
        message: error instanceof Error ? error.message : 'Tool execution failed.',
        ...(error instanceof RuntimeToolExecutionError && error.details !== undefined
          ? { details: error.details }
          : {}),
      };
    }
  }

  async #publish(event: Parameters<RuntimeEventPublisher['publish']>[0]): Promise<void> {
    try { await this.#publisher?.publish(event); } catch { /* SessionView is authoritative. */ }
  }

}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
