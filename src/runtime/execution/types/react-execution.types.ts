import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type {
  AgentLoop,
  AgentLoopLimits,
  ToolExecutorPort,
} from '../../../agent-loop/agent-loop.js';
import type {
  AgentJob,
  AgentJobError,
  AgentMessage,
  AgentUserInputRequest,
} from '../../../domain/index.js';

export interface JobExecutionStatePort {
  getJob(jobId: string): Promise<AgentJob | undefined>;
  failJob(job: AgentJob, error: AgentJobError): Promise<AgentJob>;
  cancelJob(jobId: string, expectedVersion: number): Promise<AgentJob>;
}

export interface ReactLoopExecutionInput {
  job: AgentJob;
  messages: BaseMessage[];
  prepareMessages?: (iteration: number) => Promise<BaseMessage[]>;
  tools: StructuredToolInterface[];
  exclusiveToolNames?: ReadonlySet<string>;
  validateToolCalls?: Parameters<AgentLoop['run']>[0]['validateToolCalls'];
  validateFinalAnswer?: Parameters<AgentLoop['run']>[0]['validateFinalAnswer'];
  initialIterationNo?: number;
  initialExecutedToolCalls?: number;
  resumeToolCalls?: Parameters<AgentLoop['run']>[0]['resumeToolCalls'];
  toolExecutor: ToolExecutorPort;
  outputIdFactory: () => string;
  limits: AgentLoopLimits;
}

export type ReactJobExecutionResult =
  | { type: 'completed'; job: AgentJob; message: AgentMessage }
  | { type: 'waiting_user_input'; job: AgentJob; requests: AgentUserInputRequest[] }
  | { type: 'failed'; job: AgentJob }
  | { type: 'cancelled'; job: AgentJob };
