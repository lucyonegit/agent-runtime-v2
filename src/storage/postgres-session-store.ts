import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  AgentContextSnapshotKind,
  AgentContextSnapshotStatus,
  createTask,
  inferAgentMessageKind,
  inferAgentMessageVisibility,
  type AgentContextBuild,
  type AgentContextSnapshot,
  type AgentCodeProject,
  type AgentInputRequest,
  type AgentMessage,
  type AgentPlan,
  type AgentPlanStep,
  type AgentSession,
  type AgentSessionTokenStats,
  type AgentTask,
} from '../domain/index.js';
import type {
  AgentSessionStore,
  AppendMessageInput,
  CreateInputRequestInput,
  CreateSessionInput,
  CreateContextSnapshotInput,
  ReplaceActiveContextSnapshotInput,
  CreateContextBuildInput,
  CompleteContextBuildInput,
  CreateCodeProjectInput,
  CreateTaskInput,
  CreatePlanInput,
  CreatePlanStepInput,
} from './session-store.js';

export {
  initializePostgresSessionStoreSchema,
  resetPostgresSessionStoreSchema,
} from './postgres-schema.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;
const ACTIVE_TASK_STATUSES = ['created', 'running', 'waiting_user_input', 'resuming'] as const;


export class PostgresSessionStore implements AgentSessionStore {
  constructor(private readonly pool: Pool) {}

  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    const session: AgentSession = {
      id: input.id,
      title: input.title,
      mode: input.mode,
      status: 'active',
      createdAt: input.now,
      updatedAt: input.now,
    };
    await this.pool.query(
      `
      insert into agent_sessions (
        id,
        title,
        mode,
        status,
        created_at_ms,
        updated_at_ms
      )
      values ($1, $2, $3, $4, $5, $6)
      `,
      [
        session.id,
        session.title ?? null,
        session.mode,
        session.status,
        session.createdAt,
        session.updatedAt,
      ]
    );
    return session;
  }

  async getSession(sessionId: string): Promise<AgentSession | null> {
    const result = await this.pool.query('select * from agent_sessions where id = $1', [sessionId]);
    return result.rows[0] ? this.toSession(result.rows[0]) : null;
  }

  async listSessions(): Promise<AgentSession[]> {
    const result = await this.pool.query(
      'select * from agent_sessions order by updated_at_ms desc, created_at_ms desc, id asc'
    );
    return result.rows.map(row => this.toSession(row));
  }

  async deleteSession(sessionId: string): Promise<AgentSession> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const sessionResult = await client.query('select * from agent_sessions where id = $1 for update', [sessionId]);
      if (sessionResult.rowCount === 0) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      await this.ensureNoActiveTasks(client, sessionId);
      await client.query('delete from agent_sessions where id = $1', [sessionId]);
      await client.query('commit');
      return this.toSession(sessionResult.rows[0]);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async createTask(input: CreateTaskInput): Promise<AgentTask> {
    const task = createTask(input);
    try {
      await this.pool.query(
        `
        insert into agent_tasks (
          id,
          session_id,
          parent_task_id,
          project_id,
          kind,
          executor,
          phase,
          route_mode,
          status,
          execution_id,
          lease_owner,
          lease_expires_at_ms,
          version,
          metadata,
          created_at_ms,
          updated_at_ms
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        `,
        [
          task.id,
          task.sessionId,
          task.parentTaskId ?? null,
          task.projectId ?? null,
          task.kind,
          task.executor ?? null,
          task.phase ?? null,
          task.routeMode ?? null,
          task.status,
          task.executionId ?? null,
          task.leaseOwner ?? null,
          task.leaseExpiresAt ?? null,
          task.version,
          this.toJson(task.metadata),
          task.createdAt,
          task.updatedAt,
        ]
      );
    } catch (error) {
      if (this.isActiveRootTaskConflict(error)) {
        throw new Error(`Active root task already exists for session: ${task.sessionId}`);
      }
      throw error;
    }
    return task;
  }

  async updateTask(taskId: string, patch: Partial<AgentTask> & { updatedAt: number }): Promise<AgentTask> {
    const existing = await this.getTask(taskId);
    if (!existing) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const expectedVersion = patch.version ?? existing.version;
    const updated: AgentTask = {
      ...existing,
      ...patch,
      version: existing.version,
    };
    try {
      const result = await this.pool.query(
        `
        update agent_tasks
        set
          session_id = $2,
          parent_task_id = $3,
          project_id = $4,
          kind = $5,
          executor = $6,
          phase = $7,
          route_mode = $8,
          status = $9,
          execution_id = $10,
          lease_owner = $11,
          lease_expires_at_ms = $12,
          waiting_request_id = $13,
          waiting_request_ids = $14,
          error = $15,
          metadata = $16,
          created_at_ms = $17,
          updated_at_ms = $18,
          started_at_ms = $19,
          completed_at_ms = $20,
          version = version + 1
        where id = $1
          and version = $21
        returning *
        `,
        [
          updated.id,
          updated.sessionId,
          updated.parentTaskId ?? null,
          updated.projectId ?? null,
          updated.kind,
          updated.executor ?? null,
          updated.phase ?? null,
          updated.routeMode ?? null,
          updated.status,
          updated.executionId ?? null,
          updated.leaseOwner ?? null,
          updated.leaseExpiresAt ?? null,
          updated.waitingRequestId ?? null,
          this.toJson(updated.waitingRequestIds),
          this.toJson(updated.error),
          this.toJson(updated.metadata),
          updated.createdAt,
          updated.updatedAt,
          updated.startedAt ?? null,
          updated.completedAt ?? null,
          expectedVersion,
        ]
      );
      if (result.rowCount === 0) {
        throw new Error(`Task was updated concurrently: ${taskId}`);
      }
      return this.toTask(result.rows[0]);
    } catch (error) {
      if (this.isActiveRootTaskConflict(error)) {
        throw new Error(`Active root task already exists for session: ${updated.sessionId}`);
      }
      throw error;
    }
  }

  async appendMessage(input: AppendMessageInput): Promise<AgentMessage> {
    const messageKind = input.messageKind ?? inferAgentMessageKind(input);
    const visibility = input.visibility ?? inferAgentMessageVisibility({ ...input, messageKind });
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const sessionResult = await client.query(
        `
        update agent_sessions
        set updated_at_ms = $2
        where id = $1
        `,
        [input.sessionId, input.createdAt]
      );
      if (sessionResult.rowCount === 0) {
        throw new Error(`Session not found: ${input.sessionId}`);
      }

      const result = await client.query(
        `
        insert into agent_messages (
          id,
          session_id,
          task_id,
          plan_id,
          step_id,
          output_id,
          role,
          message_kind,
          visibility,
          content,
          created_at_ms,
          channel,
          tool_calls,
          tool_result,
          metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        returning *
        `,
        [
          input.id,
          input.sessionId,
          input.taskId,
          input.planId ?? null,
          input.stepId ?? null,
          input.outputId ?? null,
          input.role,
          messageKind,
          visibility,
          input.content,
          input.createdAt,
          input.channel ?? null,
          this.toJson(input.toolCalls),
          this.toJson(input.toolResult),
          this.toJson(input.metadata),
        ]
      );
      await client.query('commit');
      return this.toMessage(result.rows[0]);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async createInputRequest(input: CreateInputRequestInput): Promise<AgentInputRequest> {
    const request: AgentInputRequest = {
      id: input.id,
      sessionId: input.sessionId,
      taskId: input.taskId,
      planId: input.planId,
      stepId: input.stepId,
      source: input.source,
      toolCallMessageId: input.toolCallMessageId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      resumeMode: input.resumeMode,
      status: 'pending',
      title: input.title,
      prompt: input.prompt,
      input: input.input,
      createdAt: input.now,
      updatedAt: input.now,
    };
    await this.pool.query(
      `
      insert into agent_input_requests (
        id,
        session_id,
        task_id,
        plan_id,
        step_id,
        source,
        tool_call_id,
        tool_call_message_id,
        tool_name,
        resume_mode,
        status,
        title,
        prompt,
        input,
        created_at_ms,
        updated_at_ms
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `,
      [
        request.id,
        request.sessionId,
        request.taskId,
        request.planId ?? null,
        request.stepId ?? null,
        request.source,
        request.toolCallId ?? null,
        request.toolCallMessageId ?? null,
        request.toolName ?? null,
        request.resumeMode,
        request.status,
        request.title ?? null,
        request.prompt,
        this.toJson(request.input),
        request.createdAt,
        request.updatedAt,
      ]
    );
    return request;
  }

  async answerInputRequest(
    requestId: string,
    answer: NonNullable<AgentInputRequest['answer']>
  ): Promise<AgentInputRequest> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const existingResult = await client.query(
        'select * from agent_input_requests where id = $1 for update',
        [requestId]
      );
      if (existingResult.rowCount === 0) {
        throw new Error(`Input request not found: ${requestId}`);
      }
      const existing = this.toInputRequest(existingResult.rows[0]);
      if (existing.status !== 'pending') {
        throw new Error(`Input request is not pending: ${requestId}`);
      }

      const updatedResult = await client.query(
        `
        update agent_input_requests
        set status = 'answered',
            answer = $2,
            answer_message_id = $3,
            updated_at_ms = $4
        where id = $1
        returning *
        `,
        [requestId, this.toJson(answer), answer.messageId ?? null, answer.answeredAt]
      );
      await client.query('commit');
      return this.toInputRequest(updatedResult.rows[0]);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async createPlan(input: CreatePlanInput): Promise<AgentPlan> {
    const plan: AgentPlan = {
      id: input.id,
      sessionId: input.sessionId,
      rootTaskId: input.rootTaskId,
      title: input.title,
      status: input.status ?? 'created',
      version: 0,
      metadata: input.metadata,
      createdAt: input.now,
      updatedAt: input.now,
    };
    const result = await this.pool.query(
      `
      insert into agent_plans (
        id, session_id, root_task_id, title, status, version, metadata, created_at_ms, updated_at_ms
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      returning *
      `,
      [
        plan.id,
        plan.sessionId,
        plan.rootTaskId,
        plan.title,
        plan.status,
        plan.version,
        this.toJson(plan.metadata),
        plan.createdAt,
        plan.updatedAt,
      ]
    );
    return this.toPlan(result.rows[0]);
  }

  async getPlan(planId: string): Promise<AgentPlan | null> {
    const result = await this.pool.query('select * from agent_plans where id = $1', [planId]);
    return result.rows[0] ? this.toPlan(result.rows[0]) : null;
  }

  async listPlans(sessionId: string): Promise<AgentPlan[]> {
    const result = await this.pool.query(
      'select * from agent_plans where session_id = $1 order by created_at_ms asc, id asc',
      [sessionId]
    );
    return result.rows.map(row => this.toPlan(row));
  }

  async updatePlan(planId: string, patch: Partial<AgentPlan> & { updatedAt: number }): Promise<AgentPlan> {
    const existing = await this.getPlan(planId);
    if (!existing) throw new Error(`Plan not found: ${planId}`);
    const expectedVersion = patch.version ?? existing.version;
    const updated: AgentPlan = { ...existing, ...patch, version: existing.version };
    const result = await this.pool.query(
      `
      update agent_plans
      set title = $2,
          status = $3,
          metadata = $4,
          updated_at_ms = $5,
          completed_at_ms = $6,
          version = version + 1
      where id = $1 and version = $7
      returning *
      `,
      [
        updated.id,
        updated.title,
        updated.status,
        this.toJson(updated.metadata),
        updated.updatedAt,
        updated.completedAt ?? null,
        expectedVersion,
      ]
    );
    if (result.rowCount === 0) {
      throw new Error(`Plan was updated concurrently: ${planId}`);
    }
    return this.toPlan(result.rows[0]);
  }

  async createPlanStep(input: CreatePlanStepInput): Promise<AgentPlanStep> {
    const step: AgentPlanStep = {
      id: input.id,
      planId: input.planId,
      taskId: input.taskId,
      position: input.position,
      title: input.title,
      instruction: input.instruction,
      status: input.status ?? 'pending',
      metadata: input.metadata,
      createdAt: input.now,
      updatedAt: input.now,
    };
    const result = await this.pool.query(
      `
      insert into agent_plan_steps (
        id, plan_id, task_id, position, title, instruction, status, metadata, created_at_ms, updated_at_ms
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      returning *
      `,
      [
        step.id,
        step.planId,
        step.taskId ?? null,
        step.position,
        step.title,
        step.instruction,
        step.status,
        this.toJson(step.metadata),
        step.createdAt,
        step.updatedAt,
      ]
    );
    return this.toPlanStep(result.rows[0]);
  }

  async listPlanSteps(planId: string): Promise<AgentPlanStep[]> {
    const result = await this.pool.query(
      'select * from agent_plan_steps where plan_id = $1 order by position asc, id asc',
      [planId]
    );
    return result.rows.map(row => this.toPlanStep(row));
  }

  async updatePlanStep(
    planStepId: string,
    patch: Partial<AgentPlanStep> & { updatedAt: number }
  ): Promise<AgentPlanStep> {
    const existing = await this.getPlanStep(planStepId);
    if (!existing) throw new Error(`Plan step not found: ${planStepId}`);
    const updated: AgentPlanStep = { ...existing, ...patch };
    const result = await this.pool.query(
      `
      update agent_plan_steps
      set task_id = $2,
          position = $3,
          title = $4,
          instruction = $5,
          status = $6,
          result_message_id = $7,
          error = $8,
          metadata = $9,
          updated_at_ms = $10,
          completed_at_ms = $11
      where id = $1
      returning *
      `,
      [
        updated.id,
        updated.taskId ?? null,
        updated.position,
        updated.title,
        updated.instruction,
        updated.status,
        updated.resultMessageId ?? null,
        this.toJson(updated.error),
        this.toJson(updated.metadata),
        updated.updatedAt,
        updated.completedAt ?? null,
      ]
    );
    return this.toPlanStep(result.rows[0]);
  }

  async createCodeProject(input: CreateCodeProjectInput): Promise<AgentCodeProject> {
    const project: AgentCodeProject = {
      id: input.id,
      sessionId: input.sessionId,
      title: input.title,
      status: input.status ?? 'active',
      sandboxRelativePath: input.sandboxRelativePath,
      framework: input.framework,
      language: input.language,
      packageManager: input.packageManager,
      currentInvariantsSnapshotId: input.currentInvariantsSnapshotId,
      currentIndexSnapshotId: input.currentIndexSnapshotId,
      metadata: input.metadata,
      createdAt: input.now,
      updatedAt: input.now,
    };
    const result = await this.pool.query(
      `
      insert into agent_code_projects (
        id,
        session_id,
        title,
        status,
        sandbox_relative_path,
        framework,
        language,
        package_manager,
        current_invariants_snapshot_id,
        current_index_snapshot_id,
        metadata,
        created_at_ms,
        updated_at_ms
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      returning *
      `,
      [
        project.id,
        project.sessionId,
        project.title,
        project.status,
        project.sandboxRelativePath,
        project.framework ?? null,
        project.language ?? null,
        project.packageManager ?? null,
        project.currentInvariantsSnapshotId ?? null,
        project.currentIndexSnapshotId ?? null,
        this.toJson(project.metadata),
        project.createdAt,
        project.updatedAt,
      ]
    );
    return this.toCodeProject(result.rows[0]);
  }

  async getCodeProject(projectId: string): Promise<AgentCodeProject | null> {
    const result = await this.pool.query('select * from agent_code_projects where id = $1', [projectId]);
    return result.rows[0] ? this.toCodeProject(result.rows[0]) : null;
  }

  async listCodeProjects(sessionId: string): Promise<AgentCodeProject[]> {
    const result = await this.pool.query(
      `
      select *
      from agent_code_projects
      where session_id = $1
      order by updated_at_ms desc, created_at_ms desc, id asc
      `,
      [sessionId]
    );
    return result.rows.map(row => this.toCodeProject(row));
  }

  async deleteCodeProject(input: { sessionId: string; projectId: string }): Promise<AgentCodeProject> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const projectResult = await client.query(
        `
        select *
        from agent_code_projects
        where id = $1
          and session_id = $2
        for update
        `,
        [input.projectId, input.sessionId]
      );
      if (projectResult.rowCount === 0) {
        throw new Error(`Code project not found: ${input.projectId}`);
      }
      await this.ensureNoActiveTasks(client, input.sessionId, input.projectId);
      await client.query('delete from agent_code_projects where id = $1 and session_id = $2', [
        input.projectId,
        input.sessionId,
      ]);
      await client.query('commit');
      return this.toCodeProject(projectResult.rows[0]);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async listTasks(sessionId: string): Promise<AgentTask[]> {
    const result = await this.pool.query(
      'select * from agent_tasks where session_id = $1 order by created_at_ms asc, id asc',
      [sessionId]
    );
    return result.rows.map(row => this.toTask(row));
  }

  async listMessages(sessionId: string): Promise<AgentMessage[]> {
    const result = await this.pool.query(
      'select * from agent_messages where session_id = $1 order by row_id asc',
      [sessionId]
    );
    return result.rows.map(row => this.toMessage(row));
  }

  async listMessagesAfterRowId(sessionId: string, rowId: number): Promise<AgentMessage[]> {
    const result = await this.pool.query(
      'select * from agent_messages where session_id = $1 and row_id > $2 order by row_id asc',
      [sessionId, rowId]
    );
    return result.rows.map(row => this.toMessage(row));
  }

  async listInputRequests(sessionId: string): Promise<AgentInputRequest[]> {
    const result = await this.pool.query(
      'select * from agent_input_requests where session_id = $1 order by created_at_ms asc, id asc',
      [sessionId]
    );
    return result.rows.map(row => this.toInputRequest(row));
  }

  async getActiveContextSnapshot(sessionId: string): Promise<AgentContextSnapshot | null> {
    const result = await this.pool.query(
      `
      select *
      from agent_context_snapshots
      where session_id = $1
        and kind = $2
        and status = $3
        and scope_kind = 'session'
        and scope_id = $1
        and purpose = 'conversation'
      order by source_row_id_end desc
      limit 1
      `,
      [sessionId, AgentContextSnapshotKind.RollingSummary, AgentContextSnapshotStatus.Active]
    );
    return result.rows[0] ? this.toContextSnapshot(result.rows[0]) : null;
  }

  async createContextSnapshot(input: CreateContextSnapshotInput): Promise<AgentContextSnapshot> {
    const result = await this.insertContextSnapshot(this.pool, input);
    return this.toContextSnapshot(result.rows[0]);
  }

  async replaceActiveContextSnapshot(input: ReplaceActiveContextSnapshotInput): Promise<AgentContextSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `
        update agent_context_snapshots
        set status = $3,
            updated_at_ms = $4
        where session_id = $1
          and kind = $2
          and status = $5
          and scope_kind = $6
          and scope_id = $7
          and purpose = $8
          and projection_version = $9
        `,
        [
          input.sessionId,
          AgentContextSnapshotKind.RollingSummary,
          AgentContextSnapshotStatus.Superseded,
          input.now,
          AgentContextSnapshotStatus.Active,
          input.scopeKind ?? 'session',
          input.scopeId ?? input.sessionId,
          input.purpose ?? 'conversation',
          input.projectionVersion ?? 'v1',
        ]
      );
      const result = await this.insertContextSnapshot(client, {
        ...input,
        status: AgentContextSnapshotStatus.Active,
      });
      await client.query('commit');
      return this.toContextSnapshot(result.rows[0]);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async listContextSnapshots(sessionId: string): Promise<AgentContextSnapshot[]> {
    const result = await this.pool.query(
      `
      select *
      from agent_context_snapshots
      where session_id = $1
      order by created_at_ms asc, id asc
      `,
      [sessionId]
    );
    return result.rows.map(row => this.toContextSnapshot(row));
  }

  async createContextBuild(input: CreateContextBuildInput): Promise<AgentContextBuild> {
    const result = await this.pool.query(
      `
      insert into agent_context_builds (
        id,
        session_id,
        task_id,
        parent_task_id,
        task_kind,
        executor,
        snapshot_id,
        execution_id,
        call_key,
        model,
        call_purpose,
        projection_version,
        status,
        strategy,
        max_context_tokens,
        reserved_output_tokens,
        estimated_input_tokens,
        usage_source,
        context_usage_ratio,
        included_row_id_start,
        included_row_id_end,
        breakdown,
        context_manifest,
        metadata,
        created_at_ms
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16, $17,
        'estimated', $18, $19, $20, $21, $22, $23, $24
      )
      returning *
      `,
      [
        input.id,
        input.sessionId,
        input.taskId,
        input.parentTaskId ?? null,
        input.taskKind ?? null,
        input.executor ?? null,
        input.snapshotId ?? null,
        input.executionId ?? null,
        input.callKey ?? null,
        input.model,
        input.callPurpose ?? null,
        input.projectionVersion ?? 'v1',
        'started',
        input.strategy,
        input.maxContextTokens,
        input.reservedOutputTokens,
        input.estimatedInputTokens,
        this.ratio(input.estimatedInputTokens, input.maxContextTokens),
        input.includedRowIdStart ?? null,
        input.includedRowIdEnd ?? null,
        this.toJson(input.breakdown),
        this.toJson(input.contextManifest),
        this.toJson(input.metadata),
        input.now,
      ]
    );
    return this.toContextBuild(result.rows[0]);
  }

  async completeContextBuild(buildId: string, input: CompleteContextBuildInput): Promise<AgentContextBuild> {
    const existing = await this.getContextBuild(buildId);
    if (!existing) {
      throw new Error(`Context build not found: ${buildId}`);
    }
    const actualInputTokens = input.usage?.inputTokens;
    const actualOutputTokens = input.usage?.outputTokens;
    const actualTotalTokens = input.usage?.totalTokens ?? this.sumIfKnown(actualInputTokens, actualOutputTokens);
    const result = await this.pool.query(
      `
      update agent_context_builds
      set actual_input_tokens = $2,
          actual_output_tokens = $3,
          actual_total_tokens = $4,
          cache_read_input_tokens = $5,
          cache_write_input_tokens = $6,
          usage_source = $7,
          context_usage_ratio = $8,
          output_id = $9,
          output_channel = $10,
          result_type = $11,
          tool_call_count = $12,
          tool_names = $13,
          status = 'completed',
          completed_at_ms = $14
      where id = $1
      returning *
      `,
      [
        buildId,
        actualInputTokens ?? null,
        actualOutputTokens ?? null,
        actualTotalTokens ?? null,
        input.usage?.cacheReadInputTokens ?? null,
        input.usage?.cacheWriteInputTokens ?? null,
        input.usage?.source ?? existing.usageSource,
        this.ratio(actualInputTokens ?? existing.estimatedInputTokens, existing.maxContextTokens),
        input.outputId ?? null,
        input.outputChannel ?? null,
        input.resultType ?? null,
        input.toolCallCount ?? null,
        this.toJson(input.toolNames),
        input.completedAt,
      ]
    );
    const completed = this.toContextBuild(result.rows[0]);
    await this.recomputeSessionTokenStats(completed.sessionId, input.completedAt);
    return completed;
  }

  async getSessionTokenStats(sessionId: string): Promise<AgentSessionTokenStats | null> {
    const result = await this.pool.query(
      'select * from agent_session_token_stats where session_id = $1',
      [sessionId]
    );
    return result.rows[0] ? this.toSessionTokenStats(result.rows[0]) : null;
  }

  async listContextBuilds(sessionId: string): Promise<AgentContextBuild[]> {
    const result = await this.pool.query(
      `
      select *
      from agent_context_builds
      where session_id = $1
      order by created_at_ms asc, id asc
      `,
      [sessionId]
    );
    return result.rows.map(row => this.toContextBuild(row));
  }

  private async getTask(taskId: string): Promise<AgentTask | null> {
    const result = await this.pool.query('select * from agent_tasks where id = $1', [taskId]);
    return result.rows[0] ? this.toTask(result.rows[0]) : null;
  }

  private async getPlanStep(planStepId: string): Promise<AgentPlanStep | null> {
    const result = await this.pool.query('select * from agent_plan_steps where id = $1', [planStepId]);
    return result.rows[0] ? this.toPlanStep(result.rows[0]) : null;
  }

  private async ensureNoActiveTasks(
    db: Queryable,
    sessionId: string,
    projectId?: string
  ): Promise<void> {
    const result = await db.query(
      `
      select id
      from agent_tasks
      where session_id = $1
        and status = any($2::text[])
        and ($3::text is null or project_id = $3)
      limit 1
      `,
      [sessionId, ACTIVE_TASK_STATUSES, projectId ?? null]
    );
    if ((result.rowCount ?? 0) > 0) {
      throw new Error(
        projectId
          ? `Active task exists for code project: ${projectId}`
          : `Active task exists for session: ${sessionId}`
      );
    }
  }

  private toSession(row: QueryResultRow): AgentSession {
    return {
      id: row.id,
      title: row.title ?? undefined,
      mode: row.mode,
      status: row.status,
      createdAt: Number(row.created_at_ms),
      updatedAt: Number(row.updated_at_ms),
    };
  }

  private toTask(row: QueryResultRow): AgentTask {
    return {
      id: row.id,
      sessionId: row.session_id,
      parentTaskId: row.parent_task_id ?? undefined,
      projectId: row.project_id ?? undefined,
      kind: row.kind,
      executor: row.executor ?? undefined,
      phase: row.phase ?? undefined,
      routeMode: row.route_mode ?? undefined,
      status: row.status,
      executionId: row.execution_id ?? undefined,
      leaseOwner: row.lease_owner ?? undefined,
      leaseExpiresAt: row.lease_expires_at_ms == null ? undefined : Number(row.lease_expires_at_ms),
      version: Number(row.version ?? 0),
      waitingRequestId: row.waiting_request_id ?? undefined,
      waitingRequestIds: row.waiting_request_ids ?? undefined,
      createdAt: Number(row.created_at_ms),
      updatedAt: Number(row.updated_at_ms),
      startedAt: row.started_at_ms == null ? undefined : Number(row.started_at_ms),
      completedAt: row.completed_at_ms == null ? undefined : Number(row.completed_at_ms),
      error: row.error ?? undefined,
      metadata: row.metadata ?? undefined,
    };
  }

  private toMessage(row: QueryResultRow): AgentMessage {
    const base = {
      role: row.role,
      channel: row.channel ?? undefined,
      toolCalls: row.tool_calls ?? undefined,
      toolResult: row.tool_result ?? undefined,
      metadata: row.metadata ?? undefined,
    };
    const messageKind = row.message_kind ?? inferAgentMessageKind(base);
    const visibility = row.visibility ?? inferAgentMessageVisibility({ ...base, messageKind });
    return {
      id: row.id,
      sessionId: row.session_id,
      taskId: row.task_id,
      planId: row.plan_id ?? undefined,
      stepId: row.step_id ?? undefined,
      outputId: row.output_id ?? undefined,
      rowId: Number(row.row_id ?? row.seq),
      role: row.role,
      messageKind,
      visibility,
      channel: row.channel ?? undefined,
      content: row.content,
      toolCalls: row.tool_calls ?? undefined,
      toolResult: row.tool_result ?? undefined,
      createdAt: Number(row.created_at_ms),
      metadata: row.metadata ?? undefined,
    };
  }

  private toInputRequest(row: QueryResultRow): AgentInputRequest {
    return {
      id: row.id,
      sessionId: row.session_id,
      taskId: row.task_id,
      planId: row.plan_id ?? undefined,
      stepId: row.step_id ?? undefined,
      source: row.source,
      toolCallMessageId: row.tool_call_message_id ?? undefined,
      toolCallId: row.tool_call_id ?? undefined,
      toolName: row.tool_name ?? undefined,
      resumeMode: row.resume_mode,
      status: row.status,
      title: row.title ?? undefined,
      prompt: row.prompt,
      input: row.input,
      answer: row.answer ?? undefined,
      createdAt: Number(row.created_at_ms),
      updatedAt: Number(row.updated_at_ms),
    };
  }

  private toPlan(row: QueryResultRow): AgentPlan {
    return {
      id: row.id,
      sessionId: row.session_id,
      rootTaskId: row.root_task_id,
      title: row.title,
      status: row.status,
      version: Number(row.version ?? 0),
      metadata: row.metadata ?? undefined,
      createdAt: Number(row.created_at_ms),
      updatedAt: Number(row.updated_at_ms),
      completedAt: row.completed_at_ms == null ? undefined : Number(row.completed_at_ms),
    };
  }

  private toPlanStep(row: QueryResultRow): AgentPlanStep {
    return {
      id: row.id,
      planId: row.plan_id,
      taskId: row.task_id ?? undefined,
      position: Number(row.position),
      title: row.title,
      instruction: row.instruction,
      status: row.status,
      resultMessageId: row.result_message_id ?? undefined,
      error: row.error ?? undefined,
      metadata: row.metadata ?? undefined,
      createdAt: Number(row.created_at_ms),
      updatedAt: Number(row.updated_at_ms),
      completedAt: row.completed_at_ms == null ? undefined : Number(row.completed_at_ms),
    };
  }

  private toCodeProject(row: QueryResultRow): AgentCodeProject {
    return {
      id: row.id,
      sessionId: row.session_id,
      title: row.title,
      status: row.status,
      sandboxRelativePath: row.sandbox_relative_path,
      framework: row.framework ?? undefined,
      language: row.language ?? undefined,
      packageManager: row.package_manager ?? undefined,
      currentInvariantsSnapshotId: row.current_invariants_snapshot_id ?? undefined,
      currentIndexSnapshotId: row.current_index_snapshot_id ?? undefined,
      metadata: row.metadata ?? undefined,
      createdAt: Number(row.created_at_ms),
      updatedAt: Number(row.updated_at_ms),
    };
  }

  private async insertContextSnapshot(
    db: Queryable,
    input: CreateContextSnapshotInput
  ): Promise<{ rows: QueryResultRow[] }> {
    return db.query(
      `
      insert into agent_context_snapshots (
        id,
        session_id,
        task_id,
        scope_kind,
        scope_id,
        purpose,
        projection_version,
        kind,
        status,
        source_row_id_start,
        source_row_id_end,
        base_snapshot_id,
        supersedes_snapshot_id,
        summary,
        summary_format,
        source_message_count,
        source_token_count,
        summary_token_count,
        model,
        compression_prompt_version,
        checksum,
        metadata,
        created_at_ms,
        updated_at_ms
      )
      values (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20,
        $21, $22, $23, $24
      )
      returning *
      `,
      [
        input.id,
        input.sessionId,
        input.taskId ?? null,
        input.scopeKind ?? 'session',
        input.scopeId ?? input.sessionId,
        input.purpose ?? 'conversation',
        input.projectionVersion ?? 'v1',
        input.kind,
        input.status,
        input.sourceRowIdStart,
        input.sourceRowIdEnd,
        input.baseSnapshotId ?? null,
        input.supersedesSnapshotId ?? null,
        input.summary,
        input.summaryFormat,
        input.sourceMessageCount,
        input.sourceTokenCount ?? null,
        input.summaryTokenCount ?? null,
        input.model ?? null,
        input.compressionPromptVersion,
        input.checksum ?? null,
        this.toJson(input.metadata),
        input.now,
        input.now,
      ]
    );
  }

  private toContextSnapshot(row: QueryResultRow): AgentContextSnapshot {
    return {
      id: row.id,
      sessionId: row.session_id,
      taskId: row.task_id ?? undefined,
      scopeKind: row.scope_kind,
      scopeId: row.scope_id,
      purpose: row.purpose,
      projectionVersion: row.projection_version,
      kind: row.kind,
      status: row.status,
      sourceRowIdStart: Number(row.source_row_id_start),
      sourceRowIdEnd: Number(row.source_row_id_end),
      baseSnapshotId: row.base_snapshot_id ?? undefined,
      supersedesSnapshotId: row.supersedes_snapshot_id ?? undefined,
      summary: row.summary,
      summaryFormat: row.summary_format,
      sourceMessageCount: Number(row.source_message_count),
      sourceTokenCount: row.source_token_count == null ? undefined : Number(row.source_token_count),
      summaryTokenCount: row.summary_token_count == null ? undefined : Number(row.summary_token_count),
      model: row.model ?? undefined,
      compressionPromptVersion: row.compression_prompt_version,
      checksum: row.checksum ?? undefined,
      metadata: row.metadata ?? undefined,
      createdAt: Number(row.created_at_ms),
      updatedAt: Number(row.updated_at_ms),
    };
  }

  private async getContextBuild(buildId: string): Promise<AgentContextBuild | null> {
    const result = await this.pool.query('select * from agent_context_builds where id = $1', [buildId]);
    return result.rows[0] ? this.toContextBuild(result.rows[0]) : null;
  }

  private async recomputeSessionTokenStats(sessionId: string, updatedAt: number): Promise<void> {
    await this.pool.query(
      `
      with completed_builds as (
        select *
        from agent_context_builds
        where session_id = $1
          and completed_at_ms is not null
      ),
      latest as (
        select *
        from completed_builds
        order by completed_at_ms desc, created_at_ms desc, id asc
        limit 1
      ),
      aggregate as (
        select
          count(*)::integer as total_model_calls,
          coalesce(sum(estimated_input_tokens), 0)::bigint as total_estimated_input_tokens,
          coalesce(sum(actual_input_tokens), 0)::bigint as total_actual_input_tokens,
          coalesce(sum(actual_output_tokens), 0)::bigint as total_actual_output_tokens,
          coalesce(sum(cache_read_input_tokens), 0)::bigint as total_cache_read_input_tokens,
          coalesce(sum(cache_write_input_tokens), 0)::bigint as total_cache_write_input_tokens,
          coalesce(sum(actual_total_tokens), 0)::bigint as total_tokens
        from completed_builds
      )
      insert into agent_session_token_stats (
        session_id,
        total_model_calls,
        total_estimated_input_tokens,
        total_actual_input_tokens,
        total_actual_output_tokens,
        total_cache_read_input_tokens,
        total_cache_write_input_tokens,
        total_tokens,
        latest_context_build_id,
        latest_model,
        latest_strategy,
        latest_estimated_input_tokens,
        latest_actual_input_tokens,
        latest_actual_output_tokens,
        latest_context_usage_ratio,
        max_context_tokens,
        warning_level,
        updated_at_ms
      )
      select
        $1,
        aggregate.total_model_calls,
        aggregate.total_estimated_input_tokens,
        aggregate.total_actual_input_tokens,
        aggregate.total_actual_output_tokens,
        aggregate.total_cache_read_input_tokens,
        aggregate.total_cache_write_input_tokens,
        aggregate.total_tokens,
        latest.id,
        latest.model,
        latest.strategy,
        latest.estimated_input_tokens,
        latest.actual_input_tokens,
        latest.actual_output_tokens,
        latest.context_usage_ratio,
        latest.max_context_tokens,
        case
          when latest.context_usage_ratio is null or latest.context_usage_ratio < 0.6 then 'normal'
          when latest.context_usage_ratio < 0.8 then 'high'
          else 'critical'
        end,
        $2
      from aggregate
      left join latest on true
      on conflict (session_id) do update set
        total_model_calls = excluded.total_model_calls,
        total_estimated_input_tokens = excluded.total_estimated_input_tokens,
        total_actual_input_tokens = excluded.total_actual_input_tokens,
        total_actual_output_tokens = excluded.total_actual_output_tokens,
        total_cache_read_input_tokens = excluded.total_cache_read_input_tokens,
        total_cache_write_input_tokens = excluded.total_cache_write_input_tokens,
        total_tokens = excluded.total_tokens,
        latest_context_build_id = excluded.latest_context_build_id,
        latest_model = excluded.latest_model,
        latest_strategy = excluded.latest_strategy,
        latest_estimated_input_tokens = excluded.latest_estimated_input_tokens,
        latest_actual_input_tokens = excluded.latest_actual_input_tokens,
        latest_actual_output_tokens = excluded.latest_actual_output_tokens,
        latest_context_usage_ratio = excluded.latest_context_usage_ratio,
        max_context_tokens = excluded.max_context_tokens,
        warning_level = excluded.warning_level,
        updated_at_ms = excluded.updated_at_ms
      `,
      [sessionId, updatedAt]
    );
  }

  private toContextBuild(row: QueryResultRow): AgentContextBuild {
    return {
      id: row.id,
      sessionId: row.session_id,
      taskId: row.task_id,
      parentTaskId: row.parent_task_id ?? undefined,
      taskKind: row.task_kind ?? undefined,
      executor: row.executor ?? undefined,
      snapshotId: row.snapshot_id ?? undefined,
      executionId: row.execution_id ?? undefined,
      callKey: row.call_key ?? undefined,
      status: row.status,
      projectionVersion: row.projection_version,
      model: row.model,
      callPurpose: row.call_purpose ?? undefined,
      strategy: row.strategy,
      maxContextTokens: Number(row.max_context_tokens),
      reservedOutputTokens: Number(row.reserved_output_tokens),
      estimatedInputTokens: Number(row.estimated_input_tokens),
      actualInputTokens: row.actual_input_tokens == null ? undefined : Number(row.actual_input_tokens),
      actualOutputTokens: row.actual_output_tokens == null ? undefined : Number(row.actual_output_tokens),
      actualTotalTokens: row.actual_total_tokens == null ? undefined : Number(row.actual_total_tokens),
      cacheReadInputTokens: row.cache_read_input_tokens == null
        ? undefined
        : Number(row.cache_read_input_tokens),
      cacheWriteInputTokens: row.cache_write_input_tokens == null
        ? undefined
        : Number(row.cache_write_input_tokens),
      usageSource: row.usage_source,
      contextUsageRatio: row.context_usage_ratio == null ? undefined : Number(row.context_usage_ratio),
      includedRowIdStart: row.included_row_id_start == null ? undefined : Number(row.included_row_id_start),
      includedRowIdEnd: row.included_row_id_end == null ? undefined : Number(row.included_row_id_end),
      outputId: row.output_id ?? undefined,
      outputChannel: row.output_channel ?? undefined,
      resultType: row.result_type ?? undefined,
      toolCallCount: row.tool_call_count == null ? undefined : Number(row.tool_call_count),
      toolNames: row.tool_names ?? undefined,
      breakdown: row.breakdown,
      contextManifest: row.context_manifest ?? undefined,
      error: row.error ?? undefined,
      metadata: row.metadata ?? undefined,
      createdAt: Number(row.created_at_ms),
      completedAt: row.completed_at_ms == null ? undefined : Number(row.completed_at_ms),
    };
  }

  private toSessionTokenStats(row: QueryResultRow): AgentSessionTokenStats {
    return {
      sessionId: row.session_id,
      totalModelCalls: Number(row.total_model_calls),
      totalEstimatedInputTokens: Number(row.total_estimated_input_tokens),
      totalActualInputTokens: Number(row.total_actual_input_tokens),
      totalActualOutputTokens: Number(row.total_actual_output_tokens),
      totalCacheReadInputTokens: Number(row.total_cache_read_input_tokens),
      totalCacheWriteInputTokens: Number(row.total_cache_write_input_tokens),
      totalTokens: Number(row.total_tokens),
      latestContextBuildId: row.latest_context_build_id ?? undefined,
      latestModel: row.latest_model ?? undefined,
      latestStrategy: row.latest_strategy ?? undefined,
      latestEstimatedInputTokens: row.latest_estimated_input_tokens == null
        ? undefined
        : Number(row.latest_estimated_input_tokens),
      latestActualInputTokens: row.latest_actual_input_tokens == null
        ? undefined
        : Number(row.latest_actual_input_tokens),
      latestActualOutputTokens: row.latest_actual_output_tokens == null
        ? undefined
        : Number(row.latest_actual_output_tokens),
      latestContextUsageRatio: row.latest_context_usage_ratio == null
        ? undefined
        : Number(row.latest_context_usage_ratio),
      maxContextTokens: row.max_context_tokens == null ? undefined : Number(row.max_context_tokens),
      warningLevel: row.warning_level,
      updatedAt: Number(row.updated_at_ms),
    };
  }

  private ratio(value: number | undefined, max: number): number | undefined {
    if (value === undefined || max <= 0) {
      return undefined;
    }
    return value / max;
  }

  private sumIfKnown(left?: number, right?: number): number | undefined {
    return left === undefined || right === undefined ? undefined : left + right;
  }

  private toJson(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
  }

  private isActiveRootTaskConflict(error: unknown): boolean {
    return this.isPgError(error)
      && error.code === '23505'
      && error.constraint === 'uniq_agent_tasks_active_root_per_session';
  }

  private isPgError(error: unknown): error is { code?: string; constraint?: string } {
    return typeof error === 'object' && error !== null;
  }
}
