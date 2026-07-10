import { describe, expect, it } from 'vitest';
import type { AgentMessage, AgentToolInvocation, AgentUserInputRequest } from '../src/domain/index.js';
import { redactToolArguments } from '../src/runtime/runtime-event-writer.js';
import { projectSensitiveAnswers } from '../src/view/session-view.js';

describe('public runtime projection', () => {
  it('redacts configured nested tool arguments without mutating execution input', () => {
    const arguments_ = {
      query: 'visible',
      auth: { token: 'secret', nested: { password: 'hidden' } },
    };
    const redacted = redactToolArguments(arguments_, ['auth.token', '/auth/nested/password']);
    expect(redacted).toEqual({
      query: 'visible',
      auth: { token: '[REDACTED]', nested: { password: '[REDACTED]' } },
    });
    expect(arguments_.auth.token).toBe('secret');
  });

  it('hides sensitive answers from messages, requests, and invocation results', () => {
    const message = {
      id: 'message_answer',
      content: 'secret answer',
      toolResult: { status: 'completed', result: 'secret answer', durationMs: 0 },
    } as AgentMessage;
    const invocation = {
      id: 'invocation_1',
      resultPayload: 'secret answer',
    } as AgentToolInvocation;
    const request = {
      id: 'request_1',
      sessionId: 'session_1',
      jobId: 'job_1',
      toolInvocationId: invocation.id,
      source: 'tool',
      answerMode: 'as_tool_result',
      status: 'answered',
      prompt: 'Secret?',
      inputSchema: { type: 'text' },
      answerMessageId: message.id,
      answer: 'secret answer',
      clientAnswerId: 'client_answer_1',
      version: 1,
      metadata: { sensitiveAnswer: true },
      createdAtMs: 1,
      updatedAtMs: 2,
      answeredAtMs: 2,
    } satisfies AgentUserInputRequest;

    const projected = projectSensitiveAnswers([message], [invocation], [request]);
    expect(projected.messages[0]).toMatchObject({
      content: '[Sensitive answer hidden]',
      toolResult: { status: 'completed', durationMs: 0 },
    });
    expect(projected.messages[0]?.toolResult).not.toHaveProperty('result');
    expect(projected.invocations[0]).not.toHaveProperty('resultPayload');
    expect(projected.requests[0]).not.toHaveProperty('answer');
    expect(projected.requests[0]).not.toHaveProperty('clientAnswerId');
  });
});
