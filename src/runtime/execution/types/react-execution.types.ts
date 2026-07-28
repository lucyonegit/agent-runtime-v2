import type { AgentLoopInput } from '../../loop/agent-loop.js';
import type {
  AgentMessage,
  AgentTask,
  AgentTaskRun,
  AgentUserInputRequest,
} from '../../../domain/index.js';

export interface ReActLoopExecutionInput {
  task: AgentTask;
  taskRun: AgentTaskRun;
  loopInput: Omit<AgentLoopInput, 'target'>;
}

export type ReActTaskExecutionResult =
  | { type: 'completed'; task: AgentTask; message: AgentMessage }
  | { type: 'waiting_for_user'; task: AgentTask; requests: AgentUserInputRequest[] }
  | { type: 'failed'; task: AgentTask }
  | { type: 'cancelled'; task: AgentTask };
