import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { removeCodeProjectSandbox } from '../../code-agent/project-sandbox.js';
import type { ContextBuilder } from '../../context/index.js';
import type { ReactCore } from '../../core/index.js';
import type { PlannerCore } from '../../core/index.js';
import type { AgentRunResult, CodeAgentRunResult } from '../../orchestration/index.js';
import { CodeAgent, PlannerReactAgent } from '../../orchestration/index.js';
import type { AgentSessionStore } from '../../storage/index.js';
import { removeSessionSandbox } from '../../tools/index.js';
import { loadSessionView, type AgentSessionView } from '../../view/index.js';
import type { AgentSession, AgentSessionMode } from '../../domain/index.js';
import {
  AGENT_CODE_CORE,
  AGENT_CONTEXT_BUILDER,
  AGENT_MODEL_NAME,
  AGENT_PLANNER_CORE,
  AGENT_PLANNER_STEP_REACT_CORE,
  AGENT_REACT_CORE,
  AGENT_SANDBOX_ROOT,
  AGENT_SESSION_STORE,
} from './tokens.js';
import { SseEventBus } from './sse-event-bus.js';

@Injectable()
export class AgentRuntimeService {
  constructor(
    @Inject(AGENT_SESSION_STORE)
    private readonly store: AgentSessionStore,
    @Inject(AGENT_CONTEXT_BUILDER)
    private readonly contextBuilder: ContextBuilder,
    @Inject(AGENT_REACT_CORE)
    private readonly react: ReactCore,
    @Inject(AGENT_PLANNER_CORE)
    private readonly planner: PlannerCore,
    @Inject(AGENT_PLANNER_STEP_REACT_CORE)
    private readonly plannerStepReact: ReactCore,
    @Inject(AGENT_CODE_CORE)
    private readonly code: ReactCore,
    @Inject(AGENT_SANDBOX_ROOT)
    private readonly sandboxRoot: string,
    @Inject(AGENT_MODEL_NAME)
    private readonly modelName: string | undefined,
    private readonly events: SseEventBus
  ) {}

  async loadSessionView(sessionId: string): Promise<AgentSessionView> {
    try {
      return await loadSessionView(this.store, sessionId);
    } catch (error) {
      if (error instanceof Error && error.message === `Session not found: ${sessionId}`) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  listSessions(): Promise<AgentSession[]> {
    return this.store.listSessions();
  }

  getSessionTokenStats(sessionId: string) {
    return this.store.getSessionTokenStats(sessionId);
  }

  createSession(input: {
    id?: string;
    title?: string;
    mode?: AgentSessionMode;
  }): Promise<AgentSession> {
    return this.store.createSession({
      id: input.id?.trim() || `session_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      title: input.title?.trim() || 'New conversation',
      mode: input.mode ?? 'planner_react',
      now: Date.now(),
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    const projects = await this.store.listCodeProjects(sessionId);
    try {
      await this.store.deleteSession(sessionId);
    } catch (error) {
      this.throwDeleteError(error, sessionId);
    }
    await Promise.all([
      removeSessionSandbox({ root: this.sandboxRoot, sessionId }),
      ...projects.map(project => removeCodeProjectSandbox({
        sandboxRoot: this.sandboxRoot,
        projectId: project.id,
      })),
    ]);
    this.events.close(sessionId);
  }

  async deleteCodeProject(sessionId: string, projectId: string): Promise<void> {
    try {
      await this.store.deleteCodeProject({ sessionId, projectId });
    } catch (error) {
      this.throwDeleteError(error, projectId);
    }
    await removeCodeProjectSandbox({ sandboxRoot: this.sandboxRoot, projectId });
  }

  runReact(sessionId: string, input: string): Promise<AgentRunResult> {
    return this.runPlannerReact(sessionId, input);
  }

  runPlannerReact(sessionId: string, goal: string): Promise<AgentRunResult> {
    const agent = this.createPlannerReactAgent(sessionId);
    return agent.run({ sessionId, goal });
  }

  private createPlannerReactAgent(sessionId: string): PlannerReactAgent {
    return new PlannerReactAgent({
      store: this.store,
      contextBuilder: this.contextBuilder,
      planner: this.planner,
      directReact: this.react,
      stepReact: this.plannerStepReact,
      sandboxRoot: this.sandboxRoot,
      modelName: this.modelName,
      onEvent: patch => this.events.publish(sessionId, patch),
    });
  }

  runCode(
    sessionId: string,
    input: {
      input: string;
      projectId?: string;
      projectTitle?: string;
    }
  ): Promise<CodeAgentRunResult> {
    const agent = new CodeAgent({
      store: this.store,
      contextBuilder: this.contextBuilder,
      core: this.code,
      sandboxRoot: this.sandboxRoot,
      modelName: this.modelName,
      onEvent: patch => this.events.publish(sessionId, patch),
    });
    return agent.run({
      sessionId,
      input: input.input,
      projectId: input.projectId,
      projectTitle: input.projectTitle,
    });
  }

  async answerInputRequest(
    sessionId: string,
    requestId: string,
    value: unknown
  ): Promise<AgentRunResult> {
    const requests = await this.store.listInputRequests(sessionId);
    const request = requests.find(item => item.id === requestId);
    if (!request) {
      throw new Error(`Input request not found: ${requestId}`);
    }
    const tasks = await this.store.listTasks(sessionId);
    const task = tasks.find(item => item.id === request.taskId);
    if (!task) {
      throw new Error(`Task not found for input request: ${requestId}`);
    }

    if (task.kind === 'code') {
      const agent = new CodeAgent({
        store: this.store,
        contextBuilder: this.contextBuilder,
        core: this.code,
        sandboxRoot: this.sandboxRoot,
        modelName: this.modelName,
        onEvent: patch => this.events.publish(sessionId, patch),
      });
      return agent.answerInputRequest({ sessionId, requestId, value });
    }

    return this.createPlannerReactAgent(sessionId)
      .answerInputRequest({ sessionId, requestId, value });
  }

  private throwDeleteError(error: unknown, id: string): never {
    if (error instanceof Error) {
      if (error.message.includes('not found')) {
        throw new NotFoundException(error.message);
      }
      if (error.message.includes('Active task exists')) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
    throw new Error(`Delete failed: ${id}`);
  }
}
