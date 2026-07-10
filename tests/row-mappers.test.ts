import { describe, expect, it } from 'vitest';
import {
  mapAgentJobRow,
  mapAgentMessageRow,
  mapAgentSessionRow,
} from '../src/storage/postgres/row-mappers.js';

describe('PostgreSQL row mappers', () => {
  it('maps bigint strings and omits nullable session and job fields', () => {
    expect(mapAgentSessionRow({
      id: 'session_1',
      title: null,
      mode: 'agent',
      status: 'active',
      version: 0,
      created_at_ms: '1000',
      updated_at_ms: '1001',
    })).toEqual({
      id: 'session_1',
      mode: 'agent',
      status: 'active',
      version: 0,
      createdAtMs: 1000,
      updatedAtMs: 1001,
    });

    expect(mapAgentJobRow({
      id: 'job_1',
      session_id: 'session_1',
      project_id: null,
      retry_of_job_id: null,
      client_request_id: null,
      strategy: null,
      stage: 'routing',
      status: 'created',
      current_attempt_id: null,
      attempt_no: 0,
      lease_owner: null,
      lease_expires_at_ms: null,
      error_code: null,
      error_message: null,
      error_details: null,
      version: 0,
      metadata: null,
      created_at_ms: '1000',
      updated_at_ms: '1000',
      started_at_ms: null,
      completed_at_ms: null,
    })).toEqual({
      id: 'job_1',
      sessionId: 'session_1',
      stage: 'routing',
      status: 'created',
      attemptNo: 0,
      version: 0,
      createdAtMs: 1000,
      updatedAtMs: 1000,
    });
  });

  it('maps message protocol payloads and rejects unsafe bigint values', () => {
    expect(mapAgentMessageRow({
      row_id: '42',
      id: 'message_1',
      session_id: 'session_1',
      job_id: 'job_1',
      plan_id: null,
      step_id: null,
      step_run_id: null,
      attempt_id: null,
      output_id: null,
      role: 'user',
      message_type: 'user_message',
      visibility: 'ui',
      channel: 'normal',
      content: 'hello',
      tool_calls: null,
      tool_call_id: null,
      tool_name: null,
      tool_result: null,
      metadata: { source: 'test' },
      created_at_ms: '2000',
    })).toMatchObject({
      rowId: 42,
      content: 'hello',
      metadata: { source: 'test' },
      createdAtMs: 2000,
    });

    expect(() => mapAgentSessionRow({
      id: 'session_unsafe',
      title: null,
      mode: 'agent',
      status: 'active',
      version: 0,
      created_at_ms: '9007199254740992',
      updated_at_ms: '1',
    })).toThrow(/safe integer range/);
  });
});
