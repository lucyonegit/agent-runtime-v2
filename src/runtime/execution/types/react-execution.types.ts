import type {
  AgentLoopInput,
} from '../../loop/agent-loop.js';
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
  loopInput: Omit<AgentLoopInput, 'target'>;
}

export type ReactJobExecutionResult =
  | { type: 'completed'; job: AgentJob; message: AgentMessage }
  | { type: 'waiting_user_input'; job: AgentJob; requests: AgentUserInputRequest[] }
  | { type: 'failed'; job: AgentJob }
  | { type: 'cancelled'; job: AgentJob };
