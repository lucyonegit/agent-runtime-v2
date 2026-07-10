import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AgentContextSnapshotKind,
  AgentContextSnapshotStatus,
  createTask,
  inferAgentMessageKind,
  inferAgentMessageVisibility,
  type AgentContextSnapshot,
  type AgentContextBuild,
  type AgentSessionTokenStats,
  type AgentCodeProject,
  type AgentInputRequest,
  type AgentMessage,
  type AgentPlan,
  type AgentPlanStep,
  type AgentSession,
  type AgentTask,
} from '../domain/index.js';
import type {
  AgentSessionStore,
  AppendMessageInput,
  CreateInputRequestInput,
  CreateSessionInput,
  CreateContextSnapshotInput,
  CreateContextBuildInput,
  CompleteContextBuildInput,
  ReplaceActiveContextSnapshotInput,
  CreateTaskInput,
  CreateCodeProjectInput,
  CreatePlanInput,
  CreatePlanStepInput,
} from './session-store.js';

export class FileSessionStore implements AgentSessionStore {
  constructor(private readonly rootDir: string) {}

  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    const session: AgentSession = {
      id: input.id,
      title: input.title,
      mode: input.mode,
      status: 'active',
      createdAt: input.now,
      updatedAt: input.now,
    };

    await this.ensureSessionDir(input.id);
    await writeFile(this.sessionPath(input.id), JSON.stringify(session, null, 2), 'utf8');
    return session;
  }

  async getSession(sessionId: string): Promise<AgentSession | null> {
    const path = this.sessionPath(sessionId);
    if (!existsSync(path)) {
      return null;
    }

    return JSON.parse(await readFile(path, 'utf8')) as AgentSession;
  }

  async listSessions(): Promise<AgentSession[]> {
    const sessionIds = await this.listSessionIds();
    const sessions = await Promise.all(sessionIds.map(sessionId => this.getSession(sessionId)));
    return sessions
      .filter((session): session is AgentSession => session !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteSession(sessionId: string): Promise<AgentSession> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const tasks = await this.listTasks(sessionId);
    if (tasks.some(task => this.isActiveTaskStatus(task.status))) {
      throw new Error(`Active task exists for session: ${sessionId}`);
    }
    const projects = await this.readJsonLines<AgentCodeProject>(this.codeProjectsPath());
    await this.writeJsonLines(
      this.codeProjectsPath(),
      projects.filter(project => project.sessionId !== sessionId)
    );
    await rm(this.sessionDir(sessionId), { recursive: true, force: true });
    return session;
  }

  async createCodeProject(input: CreateCodeProjectInput): Promise<AgentCodeProject> {
    await mkdir(this.rootDir, { recursive: true });
    const projects = await this.readJsonLines<AgentCodeProject>(this.codeProjectsPath());
    if (projects.some(project => project.id === input.id)) {
      throw new Error(`Code project already exists: ${input.id}`);
    }
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
    await this.appendJsonLine(this.codeProjectsPath(), project);
    return project;
  }

  async getCodeProject(projectId: string): Promise<AgentCodeProject | null> {
    const projects = await this.readJsonLines<AgentCodeProject>(this.codeProjectsPath());
    return projects.find(project => project.id === projectId) ?? null;
  }

  async listCodeProjects(sessionId: string): Promise<AgentCodeProject[]> {
    const projects = await this.readJsonLines<AgentCodeProject>(this.codeProjectsPath());
    return projects
      .filter(project => project.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async deleteCodeProject(input: { sessionId: string; projectId: string }): Promise<AgentCodeProject> {
    const projects = await this.readJsonLines<AgentCodeProject>(this.codeProjectsPath());
    const project = projects.find(item => item.id === input.projectId && item.sessionId === input.sessionId);
    if (!project) {
      throw new Error(`Code project not found: ${input.projectId}`);
    }
    const tasks = await this.listTasks(input.sessionId);
    if (tasks.some(task =>
      this.isActiveTaskStatus(task.status)
      && task.metadata?.projectId === input.projectId
    )) {
      throw new Error(`Active task exists for code project: ${input.projectId}`);
    }
    await this.writeJsonLines(
      this.codeProjectsPath(),
      projects.filter(item => !(item.id === input.projectId && item.sessionId === input.sessionId))
    );
    return project;
  }

  async createTask(input: CreateTaskInput): Promise<AgentTask> {
    const task = createTask(input);
    await this.ensureSessionDir(input.sessionId);
    await this.ensureNoActiveRootTask(task);
    await this.appendJsonLine(this.tasksPath(input.sessionId), task);
    return task;
  }

  async updateTask(taskId: string, patch: Partial<AgentTask> & { updatedAt: number }): Promise<AgentTask> {
    const sessionId = patch.sessionId ?? await this.findSessionIdForTask(taskId);
    const tasks = await this.listTasks(sessionId);
    const index = tasks.findIndex(task => task.id === taskId);
    if (index < 0) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const current = tasks[index];
    if (patch.version !== undefined && patch.version !== current.version) {
      throw new Error(`Task was updated concurrently: ${taskId}`);
    }

    const updated: AgentTask = {
      ...current,
      ...patch,
      version: current.version + 1,
    };
    await this.ensureNoActiveRootTask(updated, taskId);
    tasks[index] = updated;
    await this.writeJsonLines(this.tasksPath(sessionId), tasks);
    return updated;
  }

  async appendMessage(input: AppendMessageInput): Promise<AgentMessage> {
    await this.ensureSessionDir(input.sessionId);
    const existing = await this.listMessages(input.sessionId);
    const message = this.normalizeMessage({
      ...input,
      rowId: existing.length === 0 ? 1 : Math.max(...existing.map(item => item.rowId)) + 1,
    }, existing.length);
    await this.appendJsonLine(this.messagesPath(input.sessionId), message);
    return message;
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
    await this.ensureSessionDir(input.sessionId);
    await this.appendJsonLine(this.inputRequestsPath(input.sessionId), request);
    return request;
  }

  async answerInputRequest(
    requestId: string,
    answer: NonNullable<AgentInputRequest['answer']>
  ): Promise<AgentInputRequest> {
    const sessionId = await this.findSessionIdForInputRequest(requestId);
    const requests = await this.listInputRequests(sessionId);
    const index = requests.findIndex(request => request.id === requestId);
    if (index < 0) {
      throw new Error(`Input request not found: ${requestId}`);
    }
    if (requests[index].status !== 'pending') {
      throw new Error(`Input request is not pending: ${requestId}`);
    }

    const updated: AgentInputRequest = {
      ...requests[index],
      status: 'answered',
      answer,
      updatedAt: answer.answeredAt,
    };
    requests[index] = updated;
    await this.writeJsonLines(this.inputRequestsPath(sessionId), requests);
    return updated;
  }

  async listTasks(sessionId: string): Promise<AgentTask[]> {
    return this.readJsonLines<AgentTask>(this.tasksPath(sessionId));
  }

  async listMessages(sessionId: string): Promise<AgentMessage[]> {
    return (await this.readJsonLines<AgentMessage>(this.messagesPath(sessionId)))
      .map((message, index) => this.normalizeMessage(message, index))
      .sort((a, b) => a.rowId - b.rowId);
  }

  async listMessagesAfterRowId(sessionId: string, rowId: number): Promise<AgentMessage[]> {
    return (await this.listMessages(sessionId)).filter(message => message.rowId > rowId);
  }

  async listInputRequests(sessionId: string): Promise<AgentInputRequest[]> {
    return this.readJsonLines<AgentInputRequest>(this.inputRequestsPath(sessionId));
  }

  async createPlan(input: CreatePlanInput): Promise<AgentPlan> {
    await this.ensureSessionDir(input.sessionId);
    const plans = await this.listPlans(input.sessionId);
    if (plans.some(plan => plan.id === input.id)) {
      throw new Error(`Plan already exists: ${input.id}`);
    }
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
    await this.appendJsonLine(this.plansPath(input.sessionId), plan);
    return plan;
  }

  async getPlan(planId: string): Promise<AgentPlan | null> {
    for (const sessionId of await this.listSessionIds()) {
      const plan = (await this.listPlans(sessionId)).find(item => item.id === planId);
      if (plan) return plan;
    }
    return null;
  }

  async listPlans(sessionId: string): Promise<AgentPlan[]> {
    return (await this.readJsonLines<AgentPlan>(this.plansPath(sessionId)))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  async updatePlan(planId: string, patch: Partial<AgentPlan> & { updatedAt: number }): Promise<AgentPlan> {
    const existing = await this.getPlan(planId);
    if (!existing) throw new Error(`Plan not found: ${planId}`);
    if (patch.version !== undefined && patch.version !== existing.version) {
      throw new Error(`Plan was updated concurrently: ${planId}`);
    }
    const plans = await this.listPlans(existing.sessionId);
    const index = plans.findIndex(plan => plan.id === planId);
    const updated: AgentPlan = { ...existing, ...patch, version: existing.version + 1 };
    plans[index] = updated;
    await this.writeJsonLines(this.plansPath(existing.sessionId), plans);
    return updated;
  }

  async createPlanStep(input: CreatePlanStepInput): Promise<AgentPlanStep> {
    const plan = await this.getPlan(input.planId);
    if (!plan) throw new Error(`Plan not found: ${input.planId}`);
    const steps = await this.listPlanSteps(input.planId);
    if (steps.some(step => step.id === input.id)) {
      throw new Error(`Plan step already exists: ${input.id}`);
    }
    if (steps.some(step => step.position === input.position)) {
      throw new Error(`Plan step position already exists: ${input.planId}/${input.position}`);
    }
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
    await this.appendJsonLine(this.planStepsPath(plan.sessionId), step);
    return step;
  }

  async listPlanSteps(planId: string): Promise<AgentPlanStep[]> {
    const plan = await this.getPlan(planId);
    if (!plan) return [];
    return (await this.readJsonLines<AgentPlanStep>(this.planStepsPath(plan.sessionId)))
      .filter(step => step.planId === planId)
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  }

  async updatePlanStep(
    planStepId: string,
    patch: Partial<AgentPlanStep> & { updatedAt: number }
  ): Promise<AgentPlanStep> {
    for (const sessionId of await this.listSessionIds()) {
      const steps = await this.readJsonLines<AgentPlanStep>(this.planStepsPath(sessionId));
      const index = steps.findIndex(step => step.id === planStepId);
      if (index < 0) continue;
      const updated: AgentPlanStep = { ...steps[index], ...patch };
      steps[index] = updated;
      await this.writeJsonLines(this.planStepsPath(sessionId), steps);
      return updated;
    }
    throw new Error(`Plan step not found: ${planStepId}`);
  }

  async getActiveContextSnapshot(sessionId: string): Promise<AgentContextSnapshot | null> {
    const snapshots = await this.listContextSnapshots(sessionId);
    return snapshots.find(snapshot =>
      snapshot.kind === AgentContextSnapshotKind.RollingSummary
      && snapshot.status === AgentContextSnapshotStatus.Active
      && snapshot.scopeKind === 'session'
      && snapshot.scopeId === sessionId
      && snapshot.purpose === 'conversation'
    ) ?? null;
  }

  async createContextSnapshot(input: CreateContextSnapshotInput): Promise<AgentContextSnapshot> {
    await this.ensureSessionDir(input.sessionId);
    const snapshot = this.toContextSnapshot(input);
    await this.appendJsonLine(this.contextSnapshotsPath(input.sessionId), snapshot);
    return snapshot;
  }

  async replaceActiveContextSnapshot(input: ReplaceActiveContextSnapshotInput): Promise<AgentContextSnapshot> {
    await this.ensureSessionDir(input.sessionId);
    const snapshots = await this.listContextSnapshots(input.sessionId);
    const updatedSnapshots = snapshots.map(snapshot => {
      if (
        snapshot.kind === AgentContextSnapshotKind.RollingSummary
        && snapshot.status === AgentContextSnapshotStatus.Active
      ) {
        return {
          ...snapshot,
          status: AgentContextSnapshotStatus.Superseded,
          updatedAt: input.now,
        };
      }
      return snapshot;
    });
    const snapshot = this.toContextSnapshot({
      ...input,
      status: AgentContextSnapshotStatus.Active,
    });
    updatedSnapshots.push(snapshot);
    await this.writeJsonLines(this.contextSnapshotsPath(input.sessionId), updatedSnapshots);
    return snapshot;
  }

  async listContextSnapshots(sessionId: string): Promise<AgentContextSnapshot[]> {
    return this.readJsonLines<AgentContextSnapshot>(this.contextSnapshotsPath(sessionId));
  }

  async createContextBuild(input: CreateContextBuildInput): Promise<AgentContextBuild> {
    await this.ensureSessionDir(input.sessionId);
    const build: AgentContextBuild = {
      id: input.id,
      sessionId: input.sessionId,
      taskId: input.taskId,
      parentTaskId: input.parentTaskId,
      taskKind: input.taskKind,
      executor: input.executor,
      snapshotId: input.snapshotId,
      executionId: input.executionId,
      callKey: input.callKey,
      status: 'started',
      projectionVersion: input.projectionVersion ?? 'v1',
      model: input.model,
      callPurpose: input.callPurpose,
      strategy: input.strategy,
      maxContextTokens: input.maxContextTokens,
      reservedOutputTokens: input.reservedOutputTokens,
      estimatedInputTokens: input.estimatedInputTokens,
      usageSource: 'estimated',
      contextUsageRatio: this.ratio(input.estimatedInputTokens, input.maxContextTokens),
      includedRowIdStart: input.includedRowIdStart,
      includedRowIdEnd: input.includedRowIdEnd,
      breakdown: input.breakdown,
      contextManifest: input.contextManifest,
      metadata: input.metadata,
      createdAt: input.now,
    };
    await this.appendJsonLine(this.contextBuildsPath(input.sessionId), build);
    return build;
  }

  async completeContextBuild(buildId: string, input: CompleteContextBuildInput): Promise<AgentContextBuild> {
    const sessionId = await this.findSessionIdForContextBuild(buildId);
    const builds = await this.listContextBuilds(sessionId);
    const index = builds.findIndex(build => build.id === buildId);
    if (index < 0) {
      throw new Error(`Context build not found: ${buildId}`);
    }

    const current = builds[index];
    const actualInputTokens = input.usage?.inputTokens;
    const actualOutputTokens = input.usage?.outputTokens;
    const actualTotalTokens = input.usage?.totalTokens
      ?? this.sumIfKnown(actualInputTokens, actualOutputTokens);
    const completed: AgentContextBuild = {
      ...current,
      actualInputTokens,
      actualOutputTokens,
      actualTotalTokens,
      cacheReadInputTokens: input.usage?.cacheReadInputTokens,
      cacheWriteInputTokens: input.usage?.cacheWriteInputTokens,
      usageSource: input.usage?.source ?? current.usageSource,
      status: 'completed',
      contextUsageRatio: this.ratio(actualInputTokens ?? current.estimatedInputTokens, current.maxContextTokens),
      outputId: input.outputId,
      outputChannel: input.outputChannel,
      resultType: input.resultType,
      toolCallCount: input.toolCallCount,
      toolNames: input.toolNames,
      completedAt: input.completedAt,
    };
    builds[index] = completed;
    await this.writeJsonLines(this.contextBuildsPath(sessionId), builds);
    await this.recomputeSessionTokenStats(sessionId, input.completedAt);
    return completed;
  }

  async getSessionTokenStats(sessionId: string): Promise<AgentSessionTokenStats | null> {
    const statsPath = this.sessionTokenStatsPath(sessionId);
    if (!existsSync(statsPath)) {
      return null;
    }
    return JSON.parse(await readFile(statsPath, 'utf8')) as AgentSessionTokenStats;
  }

  async listContextBuilds(sessionId: string): Promise<AgentContextBuild[]> {
    return this.readJsonLines<AgentContextBuild>(this.contextBuildsPath(sessionId));
  }

  private async ensureSessionDir(sessionId: string): Promise<void> {
    await mkdir(this.sessionDir(sessionId), { recursive: true });
  }

  private sessionDir(sessionId: string): string {
    return join(this.rootDir, sessionId);
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'session.json');
  }

  private tasksPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'tasks.jsonl');
  }

  private messagesPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'messages.jsonl');
  }

  private inputRequestsPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'input-requests.jsonl');
  }

  private plansPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'plans.jsonl');
  }

  private planStepsPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'plan-steps.jsonl');
  }

  private contextSnapshotsPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'context-snapshots.jsonl');
  }

  private contextBuildsPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'context-builds.jsonl');
  }

  private sessionTokenStatsPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'token-stats.json');
  }

  private codeProjectsPath(): string {
    return join(this.rootDir, 'code-projects.jsonl');
  }

  private toContextSnapshot(input: CreateContextSnapshotInput): AgentContextSnapshot {
    return {
      id: input.id,
      sessionId: input.sessionId,
      taskId: input.taskId,
      scopeKind: input.scopeKind ?? 'session',
      scopeId: input.scopeId ?? input.sessionId,
      purpose: input.purpose ?? 'conversation',
      projectionVersion: input.projectionVersion ?? 'v1',
      kind: input.kind,
      status: input.status,
      sourceRowIdStart: input.sourceRowIdStart,
      sourceRowIdEnd: input.sourceRowIdEnd,
      baseSnapshotId: input.baseSnapshotId,
      supersedesSnapshotId: input.supersedesSnapshotId,
      summary: input.summary,
      summaryFormat: input.summaryFormat,
      sourceMessageCount: input.sourceMessageCount,
      sourceTokenCount: input.sourceTokenCount,
      summaryTokenCount: input.summaryTokenCount,
      model: input.model,
      compressionPromptVersion: input.compressionPromptVersion,
      checksum: input.checksum,
      metadata: input.metadata,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  private async appendJsonLine(path: string, value: unknown): Promise<void> {
    await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8');
  }

  private normalizeMessage(
    message: (AgentMessage | AppendMessageInput) & { rowId?: number; seq?: number },
    index: number
  ): AgentMessage {
    const { seq, ...rest } = message;
    const rowId = typeof rest.rowId === 'number' ? rest.rowId : typeof seq === 'number' ? seq : index + 1;
    const messageKind = rest.messageKind ?? inferAgentMessageKind(rest);
    const visibility = rest.visibility ?? inferAgentMessageVisibility({ ...rest, messageKind });
    return {
      ...rest,
      rowId,
      messageKind,
      visibility,
    };
  }

  private async writeJsonLines(path: string, values: unknown[]): Promise<void> {
    await writeFile(path, values.map(value => JSON.stringify(value)).join('\n') + '\n', 'utf8');
  }

  private async readJsonLines<T>(path: string): Promise<T[]> {
    if (!existsSync(path)) {
      return [];
    }

    const content = await readFile(path, 'utf8');
    return content
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as T);
  }

  private async findSessionIdForTask(taskId: string): Promise<string> {
    const sessionIds = await this.listSessionIds();
    for (const sessionId of sessionIds) {
      const tasks = await this.listTasks(sessionId);
      if (tasks.some(task => task.id === taskId)) {
        return sessionId;
      }
    }
    throw new Error(`Task not found: ${taskId}`);
  }

  private async ensureNoActiveRootTask(task: AgentTask, currentTaskId?: string): Promise<void> {
    if (task.parentTaskId || !this.isActiveTaskStatus(task.status)) {
      return;
    }

    const tasks = await this.listTasks(task.sessionId);
    const existing = tasks.find(item =>
      item.id !== currentTaskId &&
      !item.parentTaskId && this.isActiveTaskStatus(item.status)
    );
    if (existing) {
      throw new Error(`Active root task already exists for session: ${task.sessionId}`);
    }
  }

  private isActiveTaskStatus(status: AgentTask['status']): boolean {
    return status === 'created'
      || status === 'running'
      || status === 'waiting_user_input'
      || status === 'resuming';
  }

  private async findSessionIdForInputRequest(requestId: string): Promise<string> {
    const sessionIds = await this.listSessionIds();
    for (const sessionId of sessionIds) {
      const requests = await this.listInputRequests(sessionId);
      if (requests.some(request => request.id === requestId)) {
        return sessionId;
      }
    }
    throw new Error(`Input request not found: ${requestId}`);
  }

  private async findSessionIdForContextBuild(buildId: string): Promise<string> {
    const sessionIds = await this.listSessionIds();
    for (const sessionId of sessionIds) {
      const builds = await this.listContextBuilds(sessionId);
      if (builds.some(build => build.id === buildId)) {
        return sessionId;
      }
    }
    throw new Error(`Context build not found: ${buildId}`);
  }

  private async recomputeSessionTokenStats(sessionId: string, updatedAt: number): Promise<void> {
    const builds = (await this.listContextBuilds(sessionId)).filter(build => build.completedAt !== undefined);
    const latest = builds.at(-1);
    const stats: AgentSessionTokenStats = {
      sessionId,
      totalModelCalls: builds.length,
      totalEstimatedInputTokens: builds.reduce((sum, build) => sum + build.estimatedInputTokens, 0),
      totalActualInputTokens: builds.reduce((sum, build) => sum + (build.actualInputTokens ?? 0), 0),
      totalActualOutputTokens: builds.reduce((sum, build) => sum + (build.actualOutputTokens ?? 0), 0),
      totalCacheReadInputTokens: builds.reduce((sum, build) => sum + (build.cacheReadInputTokens ?? 0), 0),
      totalCacheWriteInputTokens: builds.reduce((sum, build) => sum + (build.cacheWriteInputTokens ?? 0), 0),
      totalTokens: builds.reduce((sum, build) => sum + (build.actualTotalTokens ?? 0), 0),
      latestContextBuildId: latest?.id,
      latestModel: latest?.model,
      latestStrategy: latest?.strategy,
      latestEstimatedInputTokens: latest?.estimatedInputTokens,
      latestActualInputTokens: latest?.actualInputTokens,
      latestActualOutputTokens: latest?.actualOutputTokens,
      latestContextUsageRatio: latest?.contextUsageRatio,
      maxContextTokens: latest?.maxContextTokens,
      warningLevel: this.warningLevel(latest?.contextUsageRatio),
      updatedAt,
    };
    await writeFile(this.sessionTokenStatsPath(sessionId), JSON.stringify(stats, null, 2), 'utf8');
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

  private warningLevel(ratio: number | undefined): AgentSessionTokenStats['warningLevel'] {
    if (ratio === undefined || ratio < 0.6) return 'normal';
    if (ratio < 0.8) return 'high';
    return 'critical';
  }

  private async listSessionIds(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    if (!existsSync(this.rootDir)) {
      return [];
    }
    return readdir(this.rootDir);
  }
}
