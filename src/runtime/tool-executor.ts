import {
  ToolInputParsingException,
  type StructuredToolInterface,
} from '@langchain/core/tools';
import { resolve } from 'node:path';
import { isToolMessage } from '@langchain/core/messages';
import type {
  AgentArtifactDraft,
  AgentToolInvocation,
  AgentToolSideEffectLevel,
} from '../domain/index.js';
import type { ToolUserInputRequest } from '../agent-loop/loop-events.js';
import {
  FatalToolExecutionError,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolExecutorPort,
} from '../agent-loop/agent-loop.js';
import type { AgentStore } from '../storage/agent-store.js';
import { mapStoreError } from './runtime-errors.js';
import { checksumToolArguments } from './transaction-commands.js';

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
}

export interface RuntimeUserInputArtifact {
  type: 'requires_user_input';
  request: ToolUserInputRequest;
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

  constructor(options: ToolExecutorOptions) {
    this.#store = options.store;
    this.#workerId = options.workerId;
    this.#tools = new Map(options.tools.map(tool => [tool.tool.name, tool]));
    if (this.#tools.size !== options.tools.length) {
      throw new TypeError('Runtime tool names must be unique.');
    }
    this.#sandboxRoot = resolve(options.sandboxRoot ?? '.agent-sandbox');
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
  }

  tools(): StructuredToolInterface[] {
    return [...this.#tools.values()].map(tool => tool.tool);
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
        `Claimed ToolInvocation ${JSON.stringify(invocation.id)} does not match the runtime tool contract.`
      );
    }

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
    } catch (error) {
      if (request.signal?.aborted || isAbortError(error)) throw error;
      return {
        type: 'failed',
        code: error instanceof ToolInputParsingException ? 'invalid_tool_arguments' : 'tool_failed',
        message: error instanceof Error ? error.message : 'Tool execution failed.',
      };
    }
  }

  async #replayTerminalResult(invocation: AgentToolInvocation): Promise<ToolExecutionResult> {
    if (!invocation.resultMessageId) {
      return {
        type: 'failed', code: 'tool_failed',
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
    return { type: 'completed', content: message.content, result: message.toolResult.result };
  }
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
      draft.mediaType, draft.checksum].every(item => typeof item === 'string' && item.length > 0)
    && typeof draft.size === 'number'
    && Number.isSafeInteger(draft.size)
    && draft.size >= 0;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
