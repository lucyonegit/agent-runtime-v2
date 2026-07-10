import { describe, expect, it, vi } from 'vitest';
import { AgentSessionPatchType, type AgentSessionPatch } from '../src/domain/index.js';
import {
  AGENT_SERVER_PORT,
  AgentServerModule,
  AgentsController,
  SseEventBus,
  SessionsController,
} from '../src/server/index.js';
import type { AgentRuntimeService } from '../src/server/index.js';

describe('NestJS API layer', () => {
  it('exports the server module as the Nest HTTP boundary', () => {
    expect(AgentServerModule).toBeDefined();
    expect(typeof AgentServerModule.register).toBe('function');
  });

  it('uses port 3000 as the fixed server port', () => {
    expect(AGENT_SERVER_PORT).toBe(3000);
  });

  it('exposes session view loading through the sessions controller', async () => {
    const service = {
      loadSessionView: vi.fn(async (sessionId: string) => ({
        session: { id: sessionId },
        tasks: [],
        messages: [],
        inputRequests: [],
      })),
    } as unknown as AgentRuntimeService;
    const controller = new SessionsController(service);

    await expect(controller.getSessionView('session_1')).resolves.toMatchObject({
      session: { id: 'session_1' },
    });
    expect(service.loadSessionView).toHaveBeenCalledWith('session_1');
  });

  it('exposes compatibility react, planner-react, code, and HITL answer endpoints through the agents controller', async () => {
    const service = {
      runReact: vi.fn(async () => ({ sessionId: 'session_1', taskId: 'task_react', status: 'completed' })),
      runPlannerReact: vi.fn(async () => ({ sessionId: 'session_1', taskId: 'task_planner', status: 'completed' })),
      runCode: vi.fn(async () => ({
        sessionId: 'session_1',
        taskId: 'task_code',
        projectId: 'project_1',
        status: 'completed',
      })),
      answerInputRequest: vi.fn(async () => ({ sessionId: 'session_1', taskId: 'task_react', status: 'completed' })),
    } as unknown as AgentRuntimeService;
    const controller = new AgentsController(service);

    await expect(controller.runReact('session_1', { input: 'hello' })).resolves.toMatchObject({
      taskId: 'task_react',
    });
    await expect(controller.runPlannerReact('session_1', { goal: 'ship it' })).resolves.toMatchObject({
      taskId: 'task_planner',
    });
    await expect(controller.runCode('session_1', {
      input: 'create app',
      projectId: 'project_1',
      projectTitle: 'Demo App',
    })).resolves.toMatchObject({
      taskId: 'task_code',
      projectId: 'project_1',
    });
    await expect(controller.answerInputRequest('session_1', 'input_1', { value: { ok: true } }))
      .resolves.toMatchObject({ taskId: 'task_react' });

    expect(service.runReact).toHaveBeenCalledWith('session_1', 'hello');
    expect(service.runPlannerReact).toHaveBeenCalledWith('session_1', 'ship it');
    expect(service.runCode).toHaveBeenCalledWith('session_1', {
      input: 'create app',
      projectId: 'project_1',
      projectTitle: 'Demo App',
    });
    expect(service.answerInputRequest).toHaveBeenCalledWith('session_1', 'input_1', { ok: true });
  });

  it('publishes session-scoped patches as SSE message events', () => {
    const bus = new SseEventBus();
    const received: Array<{ type?: string; data?: unknown }> = [];
    const subscription = bus.observe('session_1').subscribe(event => {
      received.push(event);
    });
    const patch: AgentSessionPatch = {
      type: AgentSessionPatchType.UserMessageCreated,
      sessionId: 'session_1',
      message: {
        id: 'msg_1',
        sessionId: 'session_1',
        taskId: 'task_1',
        rowId: 1,
        role: 'user',
        content: 'hello',
        createdAt: 1,
      },
    };

    bus.publish('session_1', patch);
    bus.publish('session_2', {
      ...patch,
      sessionId: 'session_2',
      message: {
        ...patch.message,
        id: 'msg_2',
        sessionId: 'session_2',
      },
    });

    expect(received).toEqual([
      {
        type: AgentSessionPatchType.UserMessageCreated,
        data: patch,
      },
    ]);
    subscription.unsubscribe();
  });
});
