import { describe, expect, it } from 'vitest';
import {
  AGENT_RUNTIME_SCHEMA_SQL,
  AGENT_RUNTIME_TABLES,
} from '../src/storage/postgres/schema.js';

describe('single destructive PostgreSQL schema', () => {
  it('contains exactly the converged durable tables', () => {
    expect(AGENT_RUNTIME_TABLES).toEqual([
      'agent_sessions',
      'agent_tasks',
      'agent_task_runs',
      'agent_messages',
      'agent_tool_calls',
      'agent_active_plans',
      'agent_artifacts',
      'agent_user_input_requests',
      'agent_context_compactions',
      'agent_model_calls',
      'agent_model_usage_stats',
    ]);
    expect(AGENT_RUNTIME_SCHEMA_SQL).not.toMatch(/agent_jobs|agent_job_attempts|agent_tool_invocations|agent_plans|agent_plan_steps/);
    expect(AGENT_RUNTIME_SCHEMA_SQL).not.toContain("'resuming'");
  });

  it('keeps execution state on ToolCall and ToolMessage as the result fact', () => {
    expect(AGENT_RUNTIME_SCHEMA_SQL).toContain('result_message_id text references agent_messages');
    expect(AGENT_RUNTIME_SCHEMA_SQL).toContain('tool_call_id text not null references agent_tool_calls');
    expect(AGENT_RUNTIME_SCHEMA_SQL).toContain(
      'created_in_task_run_id text not null references agent_task_runs'
    );
    expect(AGENT_RUNTIME_SCHEMA_SQL).not.toContain('create table agent_tool_runs');
    expect(AGENT_RUNTIME_SCHEMA_SQL).not.toContain('create table agent_task_checkpoints');
    const toolCallTable = AGENT_RUNTIME_SCHEMA_SQL.split('create table agent_tool_calls (')[1]
      ?.split('create index idx_agent_tool_calls_recovery')[0];
    expect(toolCallTable).toBeDefined();
    expect(toolCallTable).not.toMatch(/result_payload\s+jsonb/);
    expect(toolCallTable).toContain('started_at_ms bigint');
  });
});
