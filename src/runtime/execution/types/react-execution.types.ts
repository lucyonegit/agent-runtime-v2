import type {
  AgentLoopInput,
} from '../../loop/agent-loop.js';
import type {
  AgentJob,
  AgentMessage,
  AgentUserInputRequest,
} from '../../../domain/index.js';

export interface ReActLoopExecutionInput {
  job: AgentJob;
  loopInput: Omit<AgentLoopInput, 'target'>;
}

export type ReActJobExecutionResult =
  | { type: 'completed'; job: AgentJob; message: AgentMessage }
  | { type: 'waiting_user_input'; job: AgentJob; requests: AgentUserInputRequest[] }
  | { type: 'failed'; job: AgentJob }
  | { type: 'cancelled'; job: AgentJob };
