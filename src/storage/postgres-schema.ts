import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/**
 * Canonical schema for a fresh Agent Runtime database.
 *
 * This intentionally contains no data backfills or compatibility ALTERs. Schema
 * evolution belongs in an explicit migration/reset, never in normal startup.
 */
const AGENT_RUNTIME_SCHEMA_SQL = `
  create table if not exists agent_sessions (
    id text primary key,
    title text,
    mode text not null check (mode in ('planner_react', 'code')),
    status text not null check (status in ('active', 'archived')),
    created_at_ms bigint not null,
    updated_at_ms bigint not null
  );

  create table if not exists agent_code_projects (
    id text primary key,
    session_id text not null references agent_sessions(id) on delete cascade,
    title text not null,
    status text not null check (status in ('active', 'archived', 'deleted')),
    sandbox_relative_path text not null,
    framework text,
    language text,
    package_manager text,
    current_invariants_snapshot_id text,
    current_index_snapshot_id text,
    metadata jsonb,
    created_at_ms bigint not null,
    updated_at_ms bigint not null
  );

  create index if not exists idx_agent_code_projects_session_updated
    on agent_code_projects(session_id, updated_at_ms desc, id asc);
  create index if not exists idx_agent_code_projects_status
    on agent_code_projects(status);

  create table if not exists agent_tasks (
    id text primary key,
    session_id text not null references agent_sessions(id) on delete cascade,
    parent_task_id text references agent_tasks(id) on delete cascade,
    project_id text references agent_code_projects(id) on delete set null,
    kind text not null check (kind in ('react', 'planner', 'planner_step', 'code')),
    executor text check (executor is null or executor in ('react', 'planner', 'code')),
    phase text check (phase is null or phase in ('routing', 'planning', 'executing', 'finalizing')),
    route_mode text check (route_mode is null or route_mode in ('direct', 'planned')),
    status text not null check (
      status in (
        'created',
        'running',
        'waiting_user_input',
        'resuming',
        'completed',
        'failed',
        'cancelled'
      )
    ),
    execution_id text,
    lease_owner text,
    lease_expires_at_ms bigint,
    version integer not null default 0 check (version >= 0),
    waiting_request_id text,
    waiting_request_ids jsonb,
    error jsonb,
    metadata jsonb,
    created_at_ms bigint not null,
    updated_at_ms bigint not null,
    started_at_ms bigint,
    completed_at_ms bigint
  );

  create index if not exists idx_agent_tasks_session_created
    on agent_tasks(session_id, created_at_ms asc, id asc);
  create index if not exists idx_agent_tasks_parent
    on agent_tasks(parent_task_id);
  create index if not exists idx_agent_tasks_project_active
    on agent_tasks(project_id, status)
    where project_id is not null;
  create index if not exists idx_agent_tasks_recovery
    on agent_tasks(status, lease_expires_at_ms)
    where status in ('created', 'running', 'waiting_user_input', 'resuming');
  create unique index if not exists uniq_agent_tasks_active_root_per_session
    on agent_tasks(session_id)
    where parent_task_id is null
      and status in ('created', 'running', 'waiting_user_input', 'resuming');

  create table if not exists agent_context_snapshots (
    id text primary key,
    session_id text not null references agent_sessions(id) on delete cascade,
    task_id text references agent_tasks(id) on delete set null,
    scope_kind text not null check (scope_kind in ('session', 'task', 'planner_step', 'code_project')),
    scope_id text not null,
    purpose text not null check (purpose in ('conversation', 'task_execution', 'planner_step', 'planner_final', 'code_project')),
    projection_version text not null,
    kind text not null check (
      kind in (
        'rolling_summary',
        'task_summary',
        'tool_summary',
        'memory_summary',
        'conversation_summary',
        'project_invariants',
        'project_index',
        'working_set_summary'
      )
    ),
    status text not null check (status in ('active', 'superseded', 'failed')),
    source_row_id_start bigint not null,
    source_row_id_end bigint not null,
    base_snapshot_id text references agent_context_snapshots(id) on delete set null,
    supersedes_snapshot_id text references agent_context_snapshots(id) on delete set null,
    summary text not null,
    summary_format text not null default 'markdown' check (summary_format in ('markdown', 'json')),
    source_message_count integer not null default 0 check (source_message_count >= 0),
    source_token_count integer check (source_token_count is null or source_token_count >= 0),
    summary_token_count integer check (summary_token_count is null or summary_token_count >= 0),
    model text,
    compression_prompt_version text not null,
    checksum text,
    metadata jsonb,
    created_at_ms bigint not null,
    updated_at_ms bigint not null,
    check (source_row_id_start <= source_row_id_end)
  );

  create index if not exists idx_agent_context_snapshots_scope
    on agent_context_snapshots(scope_kind, scope_id, purpose, status, source_row_id_end desc);
  create index if not exists idx_agent_context_snapshots_session_range
    on agent_context_snapshots(session_id, source_row_id_start, source_row_id_end);
  create index if not exists idx_agent_context_snapshots_task
    on agent_context_snapshots(task_id)
    where task_id is not null;
  create unique index if not exists uniq_agent_context_snapshots_active_scope
    on agent_context_snapshots(scope_kind, scope_id, purpose, projection_version, kind)
    where status = 'active';

  create table if not exists agent_plans (
    id text primary key,
    session_id text not null references agent_sessions(id) on delete cascade,
    root_task_id text not null unique references agent_tasks(id) on delete cascade,
    title text not null,
    status text not null check (
      status in ('created', 'running', 'waiting_user_input', 'completed', 'failed', 'cancelled')
    ),
    version integer not null default 0 check (version >= 0),
    metadata jsonb,
    created_at_ms bigint not null,
    updated_at_ms bigint not null,
    completed_at_ms bigint
  );

  create index if not exists idx_agent_plans_session_updated
    on agent_plans(session_id, updated_at_ms desc, id asc);
  create index if not exists idx_agent_plans_status
    on agent_plans(status);

  create table if not exists agent_plan_steps (
    id text primary key,
    plan_id text not null references agent_plans(id) on delete cascade,
    task_id text unique references agent_tasks(id) on delete set null,
    position integer not null check (position >= 0),
    title text not null,
    instruction text not null,
    status text not null check (
      status in ('pending', 'running', 'waiting_user_input', 'completed', 'failed', 'cancelled')
    ),
    result_message_id text,
    error jsonb,
    metadata jsonb,
    created_at_ms bigint not null,
    updated_at_ms bigint not null,
    completed_at_ms bigint,
    unique (plan_id, position)
  );

  create index if not exists idx_agent_plan_steps_plan_position
    on agent_plan_steps(plan_id, position asc);
  create index if not exists idx_agent_plan_steps_status
    on agent_plan_steps(plan_id, status, position asc);

  create table if not exists agent_messages (
    row_id bigserial primary key,
    id text not null unique,
    session_id text not null references agent_sessions(id) on delete cascade,
    task_id text not null references agent_tasks(id) on delete cascade,
    plan_id text references agent_plans(id) on delete set null,
    step_id text references agent_plan_steps(id) on delete set null,
    output_id text,
    role text not null check (role in ('system', 'user', 'assistant', 'tool')),
    message_kind text not null check (
      message_kind in (
        'message',
        'tool_call',
        'tool_result',
        'system_prompt',
        'planner_step_input',
        'plan',
        'plan_update',
        'step_result',
        'planner_final'
      )
    ),
    visibility text not null check (visibility in ('ui', 'internal')),
    content text not null,
    created_at_ms bigint not null,
    channel text check (channel is null or channel in ('normal', 'thought', 'final')),
    tool_calls jsonb,
    tool_result jsonb,
    metadata jsonb,
    check (
      (role = 'assistant' and tool_result is null)
      or (role = 'tool' and tool_calls is null and tool_result is not null)
      or (role in ('user', 'system') and tool_calls is null and tool_result is null)
    )
  );

  create index if not exists idx_agent_messages_session_timeline
    on agent_messages(session_id, row_id asc);
  create index if not exists idx_agent_messages_task_timeline
    on agent_messages(task_id, row_id asc);
  create index if not exists idx_agent_messages_step_timeline
    on agent_messages(step_id, row_id asc)
    where step_id is not null;
  create index if not exists idx_agent_messages_plan_timeline
    on agent_messages(plan_id, row_id asc)
    where plan_id is not null;
  create index if not exists idx_agent_messages_output
    on agent_messages(output_id)
    where output_id is not null;
  create index if not exists idx_agent_messages_kind_timeline
    on agent_messages(session_id, message_kind, row_id asc);
  create index if not exists idx_agent_messages_visible_timeline
    on agent_messages(session_id, visibility, row_id asc);
  create index if not exists idx_agent_messages_tool_calls_gin
    on agent_messages using gin (tool_calls);
  create index if not exists idx_agent_messages_tool_result_gin
    on agent_messages using gin (tool_result);

  create table if not exists agent_input_requests (
    id text primary key,
    session_id text not null references agent_sessions(id) on delete cascade,
    task_id text not null references agent_tasks(id) on delete cascade,
    plan_id text references agent_plans(id) on delete set null,
    step_id text references agent_plan_steps(id) on delete set null,
    source text not null check (source in ('tool', 'agent', 'planner')),
    tool_call_id text,
    tool_call_message_id text references agent_messages(id) on delete set null,
    tool_name text,
    resume_mode text not null check (resume_mode in ('answer_as_tool_result', 'answer_as_user_input')),
    status text not null check (status in ('pending', 'answered', 'cancelled', 'expired')),
    title text,
    prompt text not null,
    input jsonb not null,
    answer jsonb,
    answer_message_id text references agent_messages(id) on delete set null,
    created_at_ms bigint not null,
    updated_at_ms bigint not null
  );

  create index if not exists idx_agent_input_requests_session_created
    on agent_input_requests(session_id, created_at_ms asc, id asc);
  create index if not exists idx_agent_input_requests_task_status
    on agent_input_requests(task_id, status);
  create index if not exists idx_agent_input_requests_step_status
    on agent_input_requests(step_id, status)
    where step_id is not null;
  create unique index if not exists uniq_agent_input_requests_pending_tool_call
    on agent_input_requests(task_id, tool_call_id)
    where tool_call_id is not null and status = 'pending';

  create table if not exists agent_context_builds (
    id text primary key,
    session_id text not null references agent_sessions(id) on delete cascade,
    task_id text not null references agent_tasks(id) on delete cascade,
    parent_task_id text references agent_tasks(id) on delete set null,
    snapshot_id text references agent_context_snapshots(id) on delete set null,
    execution_id text,
    call_key text,
    task_kind text,
    executor text,
    model text not null,
    call_purpose text,
    projection_version text not null,
    status text not null check (status in ('started', 'completed', 'failed', 'cancelled')),
    strategy text not null,
    max_context_tokens integer not null check (max_context_tokens > 0),
    reserved_output_tokens integer not null check (reserved_output_tokens >= 0),
    estimated_input_tokens integer not null check (estimated_input_tokens >= 0),
    actual_input_tokens integer check (actual_input_tokens is null or actual_input_tokens >= 0),
    actual_output_tokens integer check (actual_output_tokens is null or actual_output_tokens >= 0),
    actual_total_tokens integer check (actual_total_tokens is null or actual_total_tokens >= 0),
    cache_read_input_tokens integer check (cache_read_input_tokens is null or cache_read_input_tokens >= 0),
    cache_write_input_tokens integer check (cache_write_input_tokens is null or cache_write_input_tokens >= 0),
    usage_source text not null check (usage_source in ('provider', 'estimated', 'mixed', 'unavailable')),
    context_usage_ratio double precision check (context_usage_ratio is null or context_usage_ratio >= 0),
    included_row_id_start bigint,
    included_row_id_end bigint,
    output_id text,
    output_channel text,
    result_type text,
    tool_call_count integer check (tool_call_count is null or tool_call_count >= 0),
    tool_names jsonb,
    breakdown jsonb not null,
    context_manifest jsonb,
    error jsonb,
    metadata jsonb,
    created_at_ms bigint not null,
    completed_at_ms bigint,
    check (
      included_row_id_start is null
      or included_row_id_end is null
      or included_row_id_start <= included_row_id_end
    )
  );

  create index if not exists idx_agent_context_builds_session_created
    on agent_context_builds(session_id, created_at_ms desc, id asc);
  create index if not exists idx_agent_context_builds_task_created
    on agent_context_builds(task_id, created_at_ms desc, id asc);
  create index if not exists idx_agent_context_builds_execution
    on agent_context_builds(execution_id, created_at_ms asc)
    where execution_id is not null;
  create index if not exists idx_agent_context_builds_status
    on agent_context_builds(status, created_at_ms asc);
  create unique index if not exists uniq_agent_context_builds_task_call_key
    on agent_context_builds(task_id, call_key)
    where call_key is not null;

  create table if not exists agent_session_token_stats (
    session_id text primary key references agent_sessions(id) on delete cascade,
    total_model_calls integer not null default 0,
    total_estimated_input_tokens bigint not null default 0,
    total_actual_input_tokens bigint not null default 0,
    total_actual_output_tokens bigint not null default 0,
    total_cache_read_input_tokens bigint not null default 0,
    total_cache_write_input_tokens bigint not null default 0,
    total_tokens bigint not null default 0,
    latest_context_build_id text references agent_context_builds(id) on delete set null,
    latest_model text,
    latest_strategy text,
    latest_estimated_input_tokens integer,
    latest_actual_input_tokens integer,
    latest_actual_output_tokens integer,
    latest_context_usage_ratio double precision,
    max_context_tokens integer,
    warning_level text not null default 'normal' check (warning_level in ('normal', 'high', 'critical')),
    updated_at_ms bigint not null
  );
`;

const RESET_AGENT_RUNTIME_SCHEMA_SQL = `
  drop table if exists
    agent_session_token_stats,
    agent_context_builds,
    agent_input_requests,
    agent_messages,
    agent_plan_steps,
    agent_plans,
    agent_context_snapshots,
    agent_tasks,
    agent_code_projects,
    agent_sessions
  cascade;
`;

export async function initializePostgresSessionStoreSchema(db: Queryable): Promise<void> {
  await db.query(AGENT_RUNTIME_SCHEMA_SQL);
}

/** Drops and recreates only Agent Runtime tables. Never call from normal startup. */
export async function resetPostgresSessionStoreSchema(db: Queryable): Promise<void> {
  await db.query(RESET_AGENT_RUNTIME_SCHEMA_SQL);
  await initializePostgresSessionStoreSchema(db);
}
