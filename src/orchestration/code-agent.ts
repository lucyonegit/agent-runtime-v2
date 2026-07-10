import type { ContextBuilder } from '../context/index.js';
import type { ReactCore } from '../core/index.js';
import type { AgentCodeProject, AgentSessionPatch } from '../domain/index.js';
import type { AgentSessionStore } from '../storage/index.js';
import {
  createCodeProjectSandbox,
  ensureCodeProjectRoot,
  getCodeProjectRelativePath,
} from '../code-agent/project-sandbox.js';
import {
  defaultIdFactory,
  type AgentRunResult,
  type Clock,
  type IdFactory,
} from './types.js';
import { ReactAgent } from './react-agent.js';
import {
  CODE_SYSTEM_PROMPT,
  CODE_SYSTEM_PROMPT_VERSION,
} from './system-prompts.js';

export interface CodeAgentConfig {
  store: AgentSessionStore;
  contextBuilder: ContextBuilder;
  core: ReactCore;
  modelName?: string;
  sandboxRoot?: string;
  ids?: IdFactory;
  clock?: Clock;
  onEvent?: (event: AgentSessionPatch) => void | Promise<void>;
}

export interface CodeAgentRunInput {
  sessionId: string;
  input: string;
  projectId?: string;
  projectTitle?: string;
}

export interface CodeAgentRunResult extends AgentRunResult {
  projectId: string;
}

export class CodeAgent {
  private readonly createId: IdFactory;
  private readonly now: Clock;

  constructor(private readonly config: CodeAgentConfig) {
    this.createId = config.ids ?? defaultIdFactory;
    this.now = config.clock ?? (() => Date.now());
  }

  async run(input: CodeAgentRunInput): Promise<CodeAgentRunResult> {
    await this.ensureSession(input.sessionId);
    const project = await this.ensureProject(input);
    await ensureCodeProjectRoot(createCodeProjectSandbox({
      sandboxRoot: this.config.sandboxRoot ?? '.agent-sandbox',
      projectId: project.id,
    }));

    const result = await this.createReactAgent(project.id).run({
      sessionId: input.sessionId,
      input: input.input,
    });
    return {
      ...result,
      projectId: project.id,
    };
  }

  async answerInputRequest(input: {
    sessionId: string;
    requestId: string;
    value: unknown;
  }): Promise<AgentRunResult> {
    const request = (await this.config.store.listInputRequests(input.sessionId))
      .find(item => item.id === input.requestId);
    if (!request) {
      throw new Error(`Input request not found: ${input.requestId}`);
    }
    const task = (await this.config.store.listTasks(input.sessionId))
      .find(item => item.id === request.taskId);
    const projectId = task?.projectId ?? task?.metadata?.projectId;
    if (!task || task.kind !== 'code' || typeof projectId !== 'string' || !projectId) {
      throw new Error(`Code task or project not found for input request: ${input.requestId}`);
    }
    await ensureCodeProjectRoot(createCodeProjectSandbox({
      sandboxRoot: this.config.sandboxRoot ?? '.agent-sandbox',
      projectId,
    }));
    return this.createReactAgent(projectId).answerInputRequest(input);
  }

  private createReactAgent(projectId: string): ReactAgent {
    return new ReactAgent({
      store: this.config.store,
      contextBuilder: this.config.contextBuilder,
      core: this.config.core,
      systemPrompt: CODE_SYSTEM_PROMPT,
      systemPromptVersion: CODE_SYSTEM_PROMPT_VERSION,
      sessionMode: 'code',
      taskKind: 'code',
      executor: 'code',
      taskProjectId: projectId,
      taskMetadata: { projectId },
      toolContext: { projectId },
      sandboxRoot: this.config.sandboxRoot,
      modelName: this.config.modelName,
      callPurpose: 'code.react.loop',
      ids: this.createId,
      clock: this.now,
      onEvent: this.config.onEvent,
    });
  }

  private async ensureSession(sessionId: string): Promise<void> {
    const existing = await this.config.store.getSession(sessionId);
    if (!existing) {
      await this.config.store.createSession({
        id: sessionId,
        mode: 'code',
        now: this.now(),
      });
    }
  }

  private async ensureProject(input: CodeAgentRunInput): Promise<AgentCodeProject> {
    if (input.projectId) {
      const existing = await this.config.store.getCodeProject(input.projectId);
      if (existing) {
        return existing;
      }
    } else {
      const existing = (await this.config.store.listCodeProjects(input.sessionId))
        .filter(project => project.status === 'active')
        .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0];
      if (existing) {
        return existing;
      }
    }

    const projectId = input.projectId?.trim() || this.createId('project');
    return this.config.store.createCodeProject({
      id: projectId,
      sessionId: input.sessionId,
      title: input.projectTitle?.trim() || 'Code project',
      status: 'active',
      sandboxRelativePath: getCodeProjectRelativePath(projectId),
      now: this.now(),
    });
  }
}
