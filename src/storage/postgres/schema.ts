import type { PoolClient } from 'pg';

export const AGENT_RUNTIME_TABLES = [
  'agent_sessions',
  'agent_tasks',
  'agent_task_runs',
  'agent_messages',
  'agent_task_checkpoints',
  'agent_tool_calls',
  'agent_tool_runs',
  'agent_active_plans',
  'agent_artifacts',
  'agent_user_input_requests',
  'agent_context_compactions',
  'agent_model_calls',
  'agent_model_usage_stats',
] as const;

export const AGENT_RUNTIME_SCHEMA_SQL = String.raw`
create table agent_sessions (
  id text primary key,
  title text,
  status text not null check (status in ('active', 'archived')),
  version integer not null default 0 check (version >= 0),
  created_at_ms bigint not null,
  updated_at_ms bigint not null
);

create table agent_tasks (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  goal_message_id text not null,
  retry_of_task_id text,
  client_request_id text,
  status text not null check (
    status in (
      'created', 'running', 'waiting_for_user', 'recovery_required',
      'completed', 'failed', 'cancelled'
    )
  ),
  error_code text,
  error_message text,
  error_details jsonb,
  version integer not null default 0 check (version >= 0),
  metadata jsonb,
  created_at_ms bigint not null,
  updated_at_ms bigint not null,
  started_at_ms bigint,
  completed_at_ms bigint,
  unique (id, session_id),
  constraint fk_agent_tasks_retry_session
    foreign key (retry_of_task_id, session_id) references agent_tasks(id, session_id)
    on delete set null (retry_of_task_id),
  check (
    (status in ('completed', 'failed', 'cancelled') and completed_at_ms is not null)
    or status not in ('completed', 'failed', 'cancelled')
  )
);

create unique index uniq_agent_tasks_active_session
  on agent_tasks(session_id)
  where status in ('created', 'running', 'waiting_for_user', 'recovery_required');

create unique index uniq_agent_tasks_client_request
  on agent_tasks(session_id, client_request_id)
  where client_request_id is not null;

create index idx_agent_tasks_session_timeline
  on agent_tasks(session_id, created_at_ms asc, id asc);

create table agent_task_runs (
  id text primary key,
  task_id text not null references agent_tasks(id) on delete cascade,
  run_no integer not null check (run_no > 0),
  trigger text not null check (
    trigger in ('initial', 'user_input_answered', 'input_expired', 'manual_resume')
  ),
  status text not null check (
    status in ('running', 'paused', 'completed', 'failed', 'interrupted', 'cancelled')
  ),
  owner_id text,
  ownership_expires_at_ms bigint,
  error_code text,
  error_message text,
  error_details jsonb,
  metadata jsonb,
  started_at_ms bigint not null,
  updated_at_ms bigint not null,
  ended_at_ms bigint,
  unique (id, task_id),
  unique (task_id, run_no),
  check (
    (status = 'running' and owner_id is not null and ownership_expires_at_ms is not null
      and ended_at_ms is null)
    or (status = 'paused' and owner_id is null and ownership_expires_at_ms is null
      and ended_at_ms is not null)
    or (status in ('completed', 'failed', 'interrupted', 'cancelled')
      and owner_id is null and ownership_expires_at_ms is null and ended_at_ms is not null)
  )
);

create unique index uniq_agent_task_runs_active
  on agent_task_runs(task_id)
  where status = 'running';

create index idx_agent_task_runs_recovery
  on agent_task_runs(status, ownership_expires_at_ms)
  where status = 'running';

create table agent_messages (
  row_id bigserial primary key,
  id text not null unique,
  session_id text not null references agent_sessions(id) on delete cascade,
  task_id text not null references agent_tasks(id) on delete cascade,
  task_run_id text references agent_task_runs(id) on delete set null,
  output_id text,
  role text not null check (role in ('system', 'user', 'assistant', 'tool')),
  message_type text not null check (
    message_type in (
      'user_message', 'assistant_message', 'tool_call', 'tool_result',
      'system_prompt', 'progress', 'error_notice', 'code_artifact'
    )
  ),
  context_scope text not null check (context_scope in ('conversation', 'task', 'none')),
  visibility text not null check (visibility in ('ui', 'internal')),
  channel text check (channel in ('normal', 'progress', 'final')),
  content text not null,
  tool_calls jsonb,
  model_tool_call_id text,
  tool_name text,
  tool_result jsonb,
  metadata jsonb,
  created_at_ms bigint not null,
  unique (id, session_id),
  unique (id, task_id),
  unique (row_id, session_id),
  check (tool_calls is null or jsonb_typeof(tool_calls) = 'array'),
  check (tool_result is null or jsonb_typeof(tool_result) = 'object')
);

alter table agent_tasks
  add constraint fk_agent_tasks_goal_message
  foreign key (goal_message_id, session_id) references agent_messages(id, session_id)
  deferrable initially deferred;

create unique index uniq_agent_messages_task_output
  on agent_messages(task_id, output_id)
  where output_id is not null;

create index idx_agent_messages_session_timeline
  on agent_messages(session_id, row_id asc);

create index idx_agent_messages_task
  on agent_messages(task_id, row_id asc);

create table agent_task_checkpoints (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  task_id text not null references agent_tasks(id) on delete cascade,
  task_run_id text not null references agent_task_runs(id) on delete cascade,
  sequence_no integer not null check (sequence_no > 0),
  phase text not null check (
    phase in ('ready_for_model', 'tool_batch', 'waiting_for_user', 'completed', 'failed', 'cancelled')
  ),
  call_message_id text references agent_messages(id) on delete restrict,
  iteration_no integer not null check (iteration_no >= 0),
  executed_tool_calls integer not null check (executed_tool_calls >= 0),
  metadata jsonb,
  created_at_ms bigint not null,
  unique (task_id, sequence_no),
  check (
    (phase in ('tool_batch', 'waiting_for_user') and call_message_id is not null)
    or (phase not in ('tool_batch', 'waiting_for_user') and call_message_id is null)
  )
);

create index idx_agent_task_checkpoints_latest
  on agent_task_checkpoints(task_id, sequence_no desc);

create table agent_tool_calls (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  task_id text not null references agent_tasks(id) on delete cascade,
  created_in_task_run_id text not null references agent_task_runs(id) on delete restrict,
  call_message_id text not null references agent_messages(id) on delete restrict,
  result_message_id text references agent_messages(id) on delete restrict,
  model_tool_call_id text not null,
  tool_name text not null,
  arguments jsonb not null check (jsonb_typeof(arguments) = 'object'),
  arguments_checksum text not null,
  side_effect_level text not null check (
    side_effect_level in ('read_only', 'idempotent', 'side_effecting')
  ),
  idempotency_key text not null,
  status text not null check (
    status in (
      'pending', 'running', 'waiting_for_user', 'completed', 'failed',
      'outcome_unknown', 'cancelled'
    )
  ),
  error_code text,
  error_message text,
  error_details jsonb,
  version integer not null default 0 check (version >= 0),
  metadata jsonb,
  created_at_ms bigint not null,
  started_at_ms bigint,
  completed_at_ms bigint,
  updated_at_ms bigint not null,
  unique (id, task_id),
  unique (task_id, model_tool_call_id),
  unique (task_id, idempotency_key),
  check (
    (status in ('completed', 'failed') and result_message_id is not null
      and completed_at_ms is not null)
    or status not in ('completed', 'failed')
  )
);

create index idx_agent_tool_calls_recovery
  on agent_tool_calls(status, updated_at_ms)
  where status in ('pending', 'running', 'waiting_for_user', 'outcome_unknown');

create table agent_tool_runs (
  id text primary key,
  tool_call_id text not null references agent_tool_calls(id) on delete cascade,
  task_id text not null references agent_tasks(id) on delete cascade,
  task_run_id text not null references agent_task_runs(id) on delete cascade,
  run_no integer not null check (run_no > 0),
  worker_id text not null,
  status text not null check (
    status in ('running', 'completed', 'failed', 'interrupted', 'outcome_unknown', 'cancelled')
  ),
  error_code text,
  error_message text,
  error_details jsonb,
  started_at_ms bigint not null,
  ended_at_ms bigint,
  duration_ms bigint,
  unique (id, tool_call_id, task_id),
  unique (tool_call_id, run_no),
  check (
    (status = 'running' and ended_at_ms is null)
    or (status <> 'running' and ended_at_ms is not null)
  )
);

create unique index uniq_agent_tool_runs_active
  on agent_tool_runs(tool_call_id)
  where status = 'running';

create table agent_active_plans (
  session_id text primary key references agent_sessions(id) on delete cascade,
  task_id text not null unique references agent_tasks(id) on delete cascade,
  title text not null,
  steps jsonb not null check (jsonb_typeof(steps) = 'array'),
  version integer not null default 0 check (version >= 0),
  created_at_ms bigint not null,
  updated_at_ms bigint not null
);

create table agent_artifacts (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  task_id text not null references agent_tasks(id) on delete cascade,
  tool_call_id text not null references agent_tool_calls(id) on delete restrict,
  tool_run_id text not null references agent_tool_runs(id) on delete restrict,
  result_message_id text not null references agent_messages(id) on delete restrict,
  kind text not null check (kind in ('file')),
  area text not null check (area in ('code', 'docs', 'artifacts', 'downloads')),
  title text not null,
  file_name text not null,
  logical_path text not null,
  storage_path text not null,
  media_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  checksum text not null,
  revision integer not null check (revision > 0),
  metadata jsonb,
  created_at_ms bigint not null,
  unique (session_id, logical_path, revision)
);

create index idx_agent_artifacts_session
  on agent_artifacts(session_id, created_at_ms asc, id asc);

create table agent_user_input_requests (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  task_id text not null references agent_tasks(id) on delete cascade,
  tool_call_id text not null unique references agent_tool_calls(id) on delete restrict,
  status text not null check (status in ('pending', 'answered', 'expired', 'cancelled')),
  title text,
  prompt text not null,
  input_schema jsonb not null check (jsonb_typeof(input_schema) = 'object'),
  answer_message_id text references agent_messages(id) on delete restrict,
  client_answer_id text,
  expires_at_ms bigint,
  version integer not null default 0 check (version >= 0),
  metadata jsonb,
  created_at_ms bigint not null,
  updated_at_ms bigint not null,
  answered_at_ms bigint,
  check (
    (status = 'answered' and answer_message_id is not null and client_answer_id is not null
      and answered_at_ms is not null)
    or status <> 'answered'
  )
);

create index idx_agent_user_input_pending
  on agent_user_input_requests(status, expires_at_ms)
  where status = 'pending';

create table agent_context_compactions (
  session_id text primary key references agent_sessions(id) on delete cascade,
  through_message_row_id bigint not null check (through_message_row_id > 0),
  summary text not null,
  version integer not null default 0 check (version >= 0),
  updated_at_ms bigint not null
);

create table agent_model_calls (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  task_id text not null references agent_tasks(id) on delete cascade,
  task_run_id text not null references agent_task_runs(id) on delete cascade,
  logical_call_key text not null,
  call_type text not null check (call_type in ('task.react', 'context.compress')),
  status text not null check (status in ('started', 'completed', 'failed', 'cancelled')),
  provider text not null,
  model text not null,
  context_rules_version text not null,
  input_manifest jsonb not null check (jsonb_typeof(input_manifest) = 'object'),
  input_messages jsonb not null check (jsonb_typeof(input_messages) = 'array'),
  input_checksum text not null,
  max_context_tokens integer not null check (max_context_tokens > 0),
  reserved_output_tokens integer not null check (reserved_output_tokens >= 0),
  estimated_input_tokens integer not null check (estimated_input_tokens >= 0),
  actual_input_tokens integer,
  actual_output_tokens integer,
  actual_total_tokens integer,
  cache_read_input_tokens integer,
  cache_write_input_tokens integer,
  usage_source text not null check (
    usage_source in ('provider', 'estimated', 'mixed', 'unavailable')
  ),
  output_id text,
  output_disposition text check (output_disposition in ('pending', 'accepted', 'rejected')),
  output_disposition_reason text,
  result_type text,
  result_payload jsonb,
  tool_names jsonb,
  error_code text,
  error_message text,
  error_details jsonb,
  metadata jsonb,
  created_at_ms bigint not null,
  completed_at_ms bigint,
  unique (id, session_id),
  unique (task_run_id, logical_call_key)
);

create index idx_agent_model_calls_session
  on agent_model_calls(session_id, created_at_ms asc, id asc);

create table agent_model_usage_stats (
  session_id text primary key references agent_sessions(id) on delete cascade,
  total_model_calls integer not null default 0,
  total_estimated_input_tokens bigint not null default 0,
  total_actual_input_tokens bigint not null default 0,
  total_actual_output_tokens bigint not null default 0,
  total_cache_read_input_tokens bigint not null default 0,
  total_cache_write_input_tokens bigint not null default 0,
  total_tokens bigint not null default 0,
  latest_model_call_id text references agent_model_calls(id) on delete set null,
  latest_model text,
  latest_context_usage_ratio double precision,
  max_context_tokens integer,
  warning_level text not null default 'normal' check (warning_level in ('normal', 'high', 'critical')),
  version integer not null default 0,
  updated_at_ms bigint not null
);

alter table agent_messages
  add constraint fk_agent_messages_task_session
    foreign key (task_id, session_id) references agent_tasks(id, session_id),
  add constraint fk_agent_messages_run_task
    foreign key (task_run_id, task_id) references agent_task_runs(id, task_id);

alter table agent_task_checkpoints
  add constraint fk_agent_checkpoints_task_session
    foreign key (task_id, session_id) references agent_tasks(id, session_id),
  add constraint fk_agent_checkpoints_run_task
    foreign key (task_run_id, task_id) references agent_task_runs(id, task_id),
  add constraint fk_agent_checkpoints_message_task
    foreign key (call_message_id, task_id) references agent_messages(id, task_id);

alter table agent_tool_calls
  add constraint fk_agent_tool_calls_task_session
    foreign key (task_id, session_id) references agent_tasks(id, session_id),
  add constraint fk_agent_tool_calls_run_task
    foreign key (created_in_task_run_id, task_id) references agent_task_runs(id, task_id),
  add constraint fk_agent_tool_calls_call_message_task
    foreign key (call_message_id, task_id) references agent_messages(id, task_id),
  add constraint fk_agent_tool_calls_result_message_task
    foreign key (result_message_id, task_id) references agent_messages(id, task_id);

alter table agent_tool_runs
  add constraint fk_agent_tool_runs_call_task
    foreign key (tool_call_id, task_id) references agent_tool_calls(id, task_id),
  add constraint fk_agent_tool_runs_run_task
    foreign key (task_run_id, task_id) references agent_task_runs(id, task_id);

alter table agent_active_plans
  add constraint fk_agent_active_plans_task_session
    foreign key (task_id, session_id) references agent_tasks(id, session_id);

alter table agent_artifacts
  add constraint fk_agent_artifacts_task_session
    foreign key (task_id, session_id) references agent_tasks(id, session_id),
  add constraint fk_agent_artifacts_call_task
    foreign key (tool_call_id, task_id) references agent_tool_calls(id, task_id),
  add constraint fk_agent_artifacts_run_lineage
    foreign key (tool_run_id, tool_call_id, task_id)
    references agent_tool_runs(id, tool_call_id, task_id),
  add constraint fk_agent_artifacts_result_message_task
    foreign key (result_message_id, task_id) references agent_messages(id, task_id);

alter table agent_user_input_requests
  add constraint fk_agent_input_requests_task_session
    foreign key (task_id, session_id) references agent_tasks(id, session_id),
  add constraint fk_agent_input_requests_call_task
    foreign key (tool_call_id, task_id) references agent_tool_calls(id, task_id),
  add constraint fk_agent_input_requests_answer_message_task
    foreign key (answer_message_id, task_id) references agent_messages(id, task_id);

alter table agent_context_compactions
  add constraint fk_agent_compactions_message_session
    foreign key (through_message_row_id, session_id)
    references agent_messages(row_id, session_id);

alter table agent_model_calls
  add constraint fk_agent_model_calls_task_session
    foreign key (task_id, session_id) references agent_tasks(id, session_id),
  add constraint fk_agent_model_calls_run_task
    foreign key (task_run_id, task_id) references agent_task_runs(id, task_id);

alter table agent_model_usage_stats
  add constraint fk_agent_usage_latest_call_session
    foreign key (latest_model_call_id, session_id) references agent_model_calls(id, session_id);
`;

export async function createAgentRuntimeSchema(client: PoolClient): Promise<void> {
  await client.query(AGENT_RUNTIME_SCHEMA_SQL);
}
