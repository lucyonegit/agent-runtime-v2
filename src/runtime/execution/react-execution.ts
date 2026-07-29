import { randomUUID } from 'node:crypto';
import type { AgentTask, AgentTaskRun } from '../../domain/index.js';
import type { AgentStore } from '../../storage/agent-store.js';
import type { ModelInputBuilder } from '../context/model-input-builder.js';
import { LoopEventHandler } from '../events/loop-event-handler.js';
import type { RuntimeEventPublisher } from '../events/runtime-event-publisher.js';
import { AgentLoop } from '../loop/agent-loop.js';
import { AuditedModelFactory } from '../model/audited-model.factory.js';
import { executeDurableAgentLoop } from './helpers/durable-loop-execution.helper.js';
import { ToolCallPolicy } from './policies/tool-call-policy.js';
import { TaskRunResumeLoader } from './recovery/task-run-resume-loader.js';
import { ToolExecutor, type RuntimeTool } from './tool-executor.js';
import type { ReActTaskExecutionResult } from './types/react-execution.types.js';

export interface ReActExecutionOptions {
  store: AgentStore;
  context: Pick<ModelInputBuilder, 'prepareTaskRunContext'>;
  workerId: string;
  publisher: RuntimeEventPublisher;
  modelFactory: AuditedModelFactory;
  tools: RuntimeTool[];
  sandboxRoot?: string;
  maxIterations: number;
  maxToolCalls: number;
  executionDeadlineMs: number;
  streaming: boolean;
  clock?: { nowMs(): number };
}

/** Runs one physical TaskRun through the single durable ReAct loop. */
export class ReActExecution {
  readonly #toolCallPolicy: ToolCallPolicy;
  readonly #resume: TaskRunResumeLoader;

  constructor(private readonly options: ReActExecutionOptions) {
    this.#toolCallPolicy = new ToolCallPolicy(options.tools);
    this.#resume = new TaskRunResumeLoader(options.store);
  }

  async runTask(input: {
    task: AgentTask;
    taskRun: AgentTaskRun;
    signal?: AbortSignal;
  }): Promise<ReActTaskExecutionResult> {
    const context = this.options.context.prepareTaskRunContext(
      input.task,
      input.taskRun,
      { signal: input.signal }
    );
    const resume = await this.#resume.load(input.task);
    const toolExecutor = new ToolExecutor({
      store: this.options.store,
      workerId: this.options.workerId,
      tools: this.options.tools,
      sandboxRoot: this.options.sandboxRoot,
      publisher: this.options.publisher,
      clock: this.options.clock,
    });
    const tools = toolExecutor.tools();

    return executeDurableAgentLoop({
      loop: new AgentLoop({
        model: this.options.modelFactory.create({
          task: input.task,
          taskRun: input.taskRun,
          manifest: context.manifest,
          callType: 'task.react',
          logicalCallKey: 'task.react',
          tools,
        }),
        createOutputId: () => `output_${randomUUID()}`,
        streaming: this.options.streaming,
      }),
      eventHandler: new LoopEventHandler({
        store: this.options.store,
        ownerId: this.options.workerId,
        tools: this.options.tools,
        publisher: this.options.publisher,
        requireModelCallAudit: true,
        clock: this.options.clock,
      }),
      store: this.options.store,
      ownerId: this.options.workerId,
      clock: this.options.clock ?? { nowMs: () => Date.now() },
      input: {
        task: input.task,
        taskRun: input.taskRun,
        loopInput: {
          context: { loadMessages: context.loadMessages },
          tools: {
            definitions: tools,
            executor: toolExecutor,
            exclusiveNames: new Set(
              this.options.tools.filter(tool => tool.exclusive).map(tool => tool.tool.name)
            ),
          },
          policy: {
            validateToolCalls: candidate => this.#toolCallPolicy.validate(candidate.toolCalls),
          },
          limits: {
            maxIterations: this.options.maxIterations,
            maxToolCalls: this.options.maxToolCalls,
            deadlineMs: input.taskRun.startedAtMs + this.options.executionDeadlineMs,
            signal: input.signal,
          },
          ...(resume ? { resume } : {}),
        },
      },
    });
  }
}
