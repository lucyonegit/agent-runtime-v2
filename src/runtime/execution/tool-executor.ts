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
import { mapStoreError } from '../errors/runtime-error.js';
import { checksumToolArguments } from './helpers/tool-call-identity.helper.js';
import { ToolInvocationReplay } from './tool-pipeline/tool-invocation-replay.js';
import { validateToolInput } from './tool-pipeline/tool-input-validator.js';
import { normalizeToolOutput } from './tool-pipeline/tool-result-normalizer.js';

export interface RuntimeToolContext {
  sessionId: string;
  jobId: string;
  sandboxRoot: string;
  attemptId: string;
  toolInvocationId: string;
  toolCallId: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface RuntimeTool {
  tool: StructuredToolInterface;
  sideEffectLevel: AgentToolSideEffectLevel;
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

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'RuntimeToolExecutionError';
    this.code = code;
    this.details = details;
  }
}

export interface ToolExecutorOptions {
  store: AgentStore;
  workerId: string;
  tools: RuntimeTool[];
  sandboxRoot?: string;
  clock?: { nowMs(): number };
}

export class ToolExecutor implements ToolExecutorPort {
  readonly #store: AgentStore;
  readonly #workerId: string;
  readonly #tools: Map<string, RuntimeTool>;
  readonly #sandboxRoot: string;
  readonly #clock: { nowMs(): number };
  readonly #replay: ToolInvocationReplay;

  constructor(options: ToolExecutorOptions) {
    this.#store = options.store;
    this.#workerId = options.workerId;
    this.#tools = new Map(options.tools.map(tool => [tool.tool.name, tool]));
    if (this.#tools.size !== options.tools.length) {
      throw new TypeError('Runtime tool names must be unique.');
    }
    this.#sandboxRoot = resolve(options.sandboxRoot ?? '.agent-sandbox');
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#replay = new ToolInvocationReplay(options.store);
  }

  tools(): StructuredToolInterface[] {
    return [...this.#tools.values()].map(tool => tool.tool);
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    let startResult;
    try {
      startResult = await this.#store.tryStartToolExecution({
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

    if (!startResult.started) return this.#replay.load(startResult.invocation);
    const invocation = startResult.invocation;
    const runtimeTool = this.#tools.get(request.call.name);
    if (!runtimeTool) {
      return { type: 'failed', code: 'tool_not_found', message: `Tool not found: ${request.call.name}` };
    }
    if (
      invocation.toolName !== request.call.name
      || invocation.argumentsChecksum !== checksumToolArguments(request.call.args)
      || invocation.sideEffectLevel !== runtimeTool.sideEffectLevel
    ) {
      throw new FatalToolExecutionError(
        'storage_error',
        `Started ToolInvocation ${JSON.stringify(invocation.id)} does not match the runtime tool contract.`
      );
    }
    const argumentLimitFailure = validateToolInput(
      request.call.args,
      runtimeTool.argumentLimits
    );
    if (argumentLimitFailure) return argumentLimitFailure;

    const context: RuntimeToolContext = {
      sessionId: request.target.sessionId,
      jobId: request.target.jobId,
      sandboxRoot: this.#sandboxRoot,
      attemptId: request.target.attemptId,
      toolInvocationId: invocation.id,
      toolCallId: invocation.toolCallId,
      idempotencyKey: invocation.idempotencyKey,
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

}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
