import type { Pool, PoolClient } from 'pg';
import type {
  AgentArtifact,
  AgentJob,
  AgentContextOwnerType,
  AgentContextPurpose,
  AgentContextSummary,
  AgentMessage,
  AgentModelCall,
  AgentModelUsageStats,
  AgentPlan,
  AgentPlanStep,
  AgentSession,
  AgentToolInvocation,
  AgentUserInputRequest,
} from '../../domain/index.js';
import type {
  AgentStore,
  CancelJobInput,
  ClaimJobInput,
  ClaimToolInvocationInput,
  ClaimToolInvocationResult,
  AnswerInputAndClaimResumeInput,
  AnswerInputAndClaimResumeResult,
  CommitModelToolCallsInput,
  CommitModelToolCallsResult,
  CommitToolResultInput,
  CommitToolResultResult,
  CompleteJobWithFinalMessageInput,
  CompleteJobWithFinalMessageResult,
  CreateInputRequestsAndMarkWaitingInput,
  CreateInputRequestsAndMarkWaitingResult,
  CreateJobAndAppendUserMessageInput,
  CreateJobAndAppendUserMessageResult,
  CreateRetryJobInput,
  CreateRetryJobResult,
  CreateSessionInput,
  ApplyPlanUpdateInput,
  ApplyPlanUpdateResult,
  StartModelCallInput,
  CompleteModelCallInput,
  CompleteModelCallResult,
  SetModelCallOutputDispositionInput,
  ReplaceContextSummaryInput,
  FailJobInput,
  RenewJobLeaseInput,
} from '../agent-store.js';
import {
  cancelJobCommand,
  claimJobCommand,
  claimToolInvocationCommand,
  answerInputAndClaimResumeCommand,
  commitModelToolCallsCommand,
  commitToolResultCommand,
  completeJobWithFinalMessageCommand,
  createInputRequestsAndMarkWaitingCommand,
  createJobAndAppendUserMessageCommand,
  createRetryJobCommand,
  createSessionCommand,
  applyPlanUpdateCommand,
  startModelCallCommand,
  completeModelCallCommand,
  setModelCallOutputDispositionCommand,
  abandonStartedModelCallsCommand,
  replaceContextSummaryCommand,
  failJobCommand,
  renewJobLeaseCommand,
} from './transaction-commands.js';
import {
  mapAgentJobRow,
  mapAgentArtifactRow,
  mapAgentMessageRow,
  mapAgentSessionRow,
  mapAgentPlanRow,
  mapAgentPlanStepRow,
  mapAgentModelCallRow,
  mapAgentModelUsageStatsRow,
  mapAgentContextSummaryRow,
  mapAgentUserInputRequestRow,
  mapAgentToolInvocationRow,
  type AgentJobRow,
  type AgentArtifactRow,
  type AgentMessageRow,
  type AgentSessionRow,
  type AgentPlanRow,
  type AgentPlanStepRow,
  type AgentModelCallRow,
  type AgentModelUsageStatsRow,
  type AgentContextSummaryRow,
  type AgentUserInputRequestRow,
  type AgentToolInvocationRow,
} from './row-mappers.js';

export class PostgresAgentStore implements AgentStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    return this.#withClient(client => createSessionCommand(client, input));
  }

  async listSessions(): Promise<AgentSession[]> {
    const result = await this.#pool.query<AgentSessionRow>(
      `select * from agent_sessions order by updated_at_ms desc, id asc`
    );
    return result.rows.map(mapAgentSessionRow);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const result = await this.#pool.query(`delete from agent_sessions where id = $1`, [sessionId]);
    return result.rowCount === 1;
  }

  async getSession(sessionId: string): Promise<AgentSession | undefined> {
    const result = await this.#pool.query<AgentSessionRow>(
      `select * from agent_sessions where id = $1`,
      [sessionId]
    );
    return result.rows[0] ? mapAgentSessionRow(result.rows[0]) : undefined;
  }

  async getJob(jobId: string): Promise<AgentJob | undefined> {
    const result = await this.#pool.query<AgentJobRow>(
      `select * from agent_jobs where id = $1`,
      [jobId]
    );
    return result.rows[0] ? mapAgentJobRow(result.rows[0]) : undefined;
  }

  async getJobByClientRequestId(
    sessionId: string,
    clientRequestId: string
  ): Promise<AgentJob | undefined> {
    const result = await this.#pool.query<AgentJobRow>(
      `select *
       from agent_jobs
       where session_id = $1 and client_request_id = $2`,
      [sessionId, clientRequestId]
    );
    return result.rows[0] ? mapAgentJobRow(result.rows[0]) : undefined;
  }

  async getToolInvocation(
    jobId: string,
    toolCallId: string
  ): Promise<AgentToolInvocation | undefined> {
    const result = await this.#pool.query<AgentToolInvocationRow>(
      `select *
       from agent_tool_invocations
       where job_id = $1 and tool_call_id = $2`,
      [jobId, toolCallId]
    );
    return result.rows[0] ? mapAgentToolInvocationRow(result.rows[0]) : undefined;
  }

  async getPlanByJobId(jobId: string): Promise<AgentPlan | undefined> {
    const result = await this.#pool.query<AgentPlanRow>(
      `select * from agent_plans where job_id = $1`,
      [jobId]
    );
    return result.rows[0] ? mapAgentPlanRow(result.rows[0]) : undefined;
  }

  async listPlanSteps(planId: string): Promise<AgentPlanStep[]> {
    const result = await this.#pool.query<AgentPlanStepRow>(
      `select * from agent_plan_steps where plan_id = $1 order by position asc`,
      [planId]
    );
    return result.rows.map(mapAgentPlanStepRow);
  }

  async getModelCall(modelCallId: string): Promise<AgentModelCall | undefined> {
    const result = await this.#pool.query<AgentModelCallRow>(
      `select * from agent_model_calls where id = $1`, [modelCallId]
    );
    return result.rows[0] ? mapAgentModelCallRow(result.rows[0]) : undefined;
  }

  async listModelCalls(jobId: string): Promise<AgentModelCall[]> {
    const result = await this.#pool.query<AgentModelCallRow>(
      `select * from agent_model_calls where job_id = $1
       order by created_at_ms asc, call_attempt_no asc, logical_call_key asc, id asc`,
      [jobId]
    );
    return result.rows.map(mapAgentModelCallRow);
  }

  async getModelUsageStats(sessionId: string): Promise<AgentModelUsageStats | undefined> {
    const result = await this.#pool.query<AgentModelUsageStatsRow>(
      `select * from agent_model_usage_stats where session_id = $1`, [sessionId]
    );
    return result.rows[0] ? mapAgentModelUsageStatsRow(result.rows[0]) : undefined;
  }

  async listActiveContextSummaries(
    ownerType: AgentContextOwnerType,
    ownerId: string,
    purpose: AgentContextPurpose,
    contextRulesVersion: string
  ): Promise<AgentContextSummary[]> {
    const result = await this.#pool.query<AgentContextSummaryRow>(
      `select * from agent_context_summaries
       where owner_type = $1 and owner_id = $2 and purpose = $3
         and context_rules_version = $4 and status = 'active'
       order by source_row_id_end desc, id asc`,
      [ownerType, ownerId, purpose, contextRulesVersion]
    );
    return result.rows.map(mapAgentContextSummaryRow);
  }

  async listSessionMessages(sessionId: string, afterRowId = 0): Promise<AgentMessage[]> {
    const result = await this.#pool.query<AgentMessageRow>(
      `select *
       from agent_messages
       where session_id = $1 and row_id > $2
       order by row_id asc`,
      [sessionId, afterRowId]
    );
    return result.rows.map(mapAgentMessageRow);
  }

  async listSessionJobs(sessionId: string): Promise<AgentJob[]> {
    const result = await this.#pool.query<AgentJobRow>(
      `select * from agent_jobs where session_id = $1 order by created_at_ms asc, id asc`, [sessionId]
    );
    return result.rows.map(mapAgentJobRow);
  }

  async listSessionPlans(sessionId: string): Promise<AgentPlan[]> {
    const result = await this.#pool.query<AgentPlanRow>(
      `select * from agent_plans where session_id = $1 order by created_at_ms asc, id asc`, [sessionId]
    );
    return result.rows.map(mapAgentPlanRow);
  }

  async listSessionPlanSteps(sessionId: string): Promise<AgentPlanStep[]> {
    const result = await this.#pool.query<AgentPlanStepRow>(
      `select step.* from agent_plan_steps step
       join agent_plans plan on plan.id = step.plan_id
       where plan.session_id = $1
       order by plan.created_at_ms asc, step.position asc`, [sessionId]
    );
    return result.rows.map(mapAgentPlanStepRow);
  }

  async listSessionToolInvocations(sessionId: string): Promise<AgentToolInvocation[]> {
    const result = await this.#pool.query<AgentToolInvocationRow>(
      `select * from agent_tool_invocations where session_id = $1
       order by created_at_ms asc, id asc`, [sessionId]
    );
    return result.rows.map(mapAgentToolInvocationRow);
  }

  async listSessionArtifacts(sessionId: string): Promise<AgentArtifact[]> {
    const result = await this.#pool.query<AgentArtifactRow>(
      `select * from agent_artifacts where session_id = $1
       order by created_at_ms asc, id asc`,
      [sessionId]
    );
    return result.rows.map(mapAgentArtifactRow);
  }

  async listSessionUserInputRequests(sessionId: string): Promise<AgentUserInputRequest[]> {
    const result = await this.#pool.query<AgentUserInputRequestRow>(
      `select * from agent_user_input_requests where session_id = $1
       order by created_at_ms asc, id asc`, [sessionId]
    );
    return result.rows.map(mapAgentUserInputRequestRow);
  }

  async createJobAndAppendUserMessage(
    input: CreateJobAndAppendUserMessageInput
  ): Promise<CreateJobAndAppendUserMessageResult> {
    return this.#withClient(client => createJobAndAppendUserMessageCommand(client, input));
  }

  async createRetryJob(input: CreateRetryJobInput): Promise<CreateRetryJobResult> {
    return this.#withClient(client => createRetryJobCommand(client, input));
  }

  async claimJob(input: ClaimJobInput): Promise<AgentJob> {
    return this.#withClient(client => claimJobCommand(client, input));
  }

  async renewJobLease(input: RenewJobLeaseInput): Promise<AgentJob> {
    return this.#withClient(client => renewJobLeaseCommand(client, input));
  }

  async commitModelToolCalls(
    input: CommitModelToolCallsInput
  ): Promise<CommitModelToolCallsResult> {
    return this.#withClient(client => commitModelToolCallsCommand(client, input));
  }

  async claimToolInvocation(
    input: ClaimToolInvocationInput
  ): Promise<ClaimToolInvocationResult> {
    return this.#withClient(client => claimToolInvocationCommand(client, input));
  }

  async commitToolResult(input: CommitToolResultInput): Promise<CommitToolResultResult> {
    return this.#withClient(client => commitToolResultCommand(client, input));
  }

  async completeJobWithFinalMessage(
    input: CompleteJobWithFinalMessageInput
  ): Promise<CompleteJobWithFinalMessageResult> {
    return this.#withClient(client => completeJobWithFinalMessageCommand(client, input));
  }

  async createInputRequestsAndMarkWaiting(
    input: CreateInputRequestsAndMarkWaitingInput
  ): Promise<CreateInputRequestsAndMarkWaitingResult> {
    return this.#withClient(client => createInputRequestsAndMarkWaitingCommand(client, input));
  }

  async answerInputAndClaimResume(
    input: AnswerInputAndClaimResumeInput
  ): Promise<AnswerInputAndClaimResumeResult> {
    return this.#withClient(client => answerInputAndClaimResumeCommand(client, input));
  }

  async applyPlanUpdate(input: ApplyPlanUpdateInput): Promise<ApplyPlanUpdateResult> {
    return this.#withClient(client => applyPlanUpdateCommand(client, input));
  }

  async startModelCall(input: StartModelCallInput): Promise<AgentModelCall> {
    return this.#withClient(client => startModelCallCommand(client, input));
  }

  async completeModelCall(input: CompleteModelCallInput): Promise<CompleteModelCallResult> {
    return this.#withClient(client => completeModelCallCommand(client, input));
  }

  async setModelCallOutputDisposition(
    input: SetModelCallOutputDispositionInput
  ): Promise<AgentModelCall> {
    return this.#withClient(client => setModelCallOutputDispositionCommand(client, input));
  }

  async abandonStartedModelCalls(nowMs: number): Promise<AgentModelCall[]> {
    return this.#withClient(client => abandonStartedModelCallsCommand(client, nowMs));
  }

  async replaceContextSummary(input: ReplaceContextSummaryInput): Promise<AgentContextSummary> {
    return this.#withClient(client => replaceContextSummaryCommand(client, input));
  }

  async failJob(input: FailJobInput): Promise<AgentJob> {
    return this.#withClient(client => failJobCommand(client, input));
  }

  async cancelJob(input: CancelJobInput): Promise<AgentJob> {
    return this.#withClient(client => cancelJobCommand(client, input));
  }

  async #withClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }
}
