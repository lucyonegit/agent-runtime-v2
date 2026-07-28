import type {
  AgentLoopInput,
} from '../../loop/agent-loop.js';
import type {
  AgentJob,
  AgentJobError,
  AgentMessage,
  AgentUserInputRequest,
} from '../../../domain/index.js';

/** Durable Job reads and terminal writes required by the ReAct executor. */
export interface JobStorePort {
  getJob(jobId: string): Promise<AgentJob | undefined>;
  fail(job: AgentJob, error: AgentJobError): Promise<AgentJob>;
  cancel(jobId: string, expectedVersion: number): Promise<AgentJob>;
}

export interface ReActLoopExecutionInput {
  job: AgentJob;
  loopInput: Omit<AgentLoopInput, 'target'>;
}

export type ReActJobExecutionResult =
  | { type: 'completed'; job: AgentJob; message: AgentMessage }
  | { type: 'waiting_user_input'; job: AgentJob; requests: AgentUserInputRequest[] }
  | { type: 'failed'; job: AgentJob }
  | { type: 'cancelled'; job: AgentJob };
