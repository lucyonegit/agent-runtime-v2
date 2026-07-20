import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export const AGENT_RUNTIME_SCHEMA_VERSION = 1;
export const AGENT_RUNTIME_SCHEMA_NAME = 'unified-job-react-canonical';

export const AGENT_RUNTIME_SCHEMA_V1_SQL = String.raw`
create table agent_schema_versions (
  version integer primary key,
  name text not null unique,
  checksum text not null,
  applied_at_ms bigint not null
);

create table agent_sessions (
  id text primary key,
  title text,
  status text not null check (status in ('active', 'archived')),
  version integer not null default 0 check (version >= 0),
  created_at_ms bigint not null,
  updated_at_ms bigint not null
);

create index idx_agent_sessions_updated
  on agent_sessions(status, updated_at_ms desc, id asc);

create table agent_jobs (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  retry_of_job_id text references agent_jobs(id) on delete set null,
  client_request_id text,

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

  current_attempt_id text,
  attempt_no integer not null default 0 check (attempt_no >= 0),
  lease_owner text,
  lease_expires_at_ms bigint,

  error_code text,
  error_message text,
  error_details jsonb,
  version integer not null default 0 check (version >= 0),
  metadata jsonb,

  created_at_ms bigint not null,
  updated_at_ms bigint not null,
  started_at_ms bigint,
  completed_at_ms bigint,

  check (
    (status in ('running', 'resuming'))
    = (lease_owner is not null and lease_expires_at_ms is not null)
  ),
  check (
    (status in ('completed', 'failed', 'cancelled') and completed_at_ms is not null)
    or status not in ('completed', 'failed', 'cancelled')
  )
);

create unique index uniq_agent_jobs_active_session
  on agent_jobs(session_id)
  where status in ('created', 'running', 'waiting_user_input', 'resuming');

create unique index uniq_agent_jobs_client_request
  on agent_jobs(session_id, client_request_id)
  where client_request_id is not null;

create index idx_agent_jobs_session_timeline
  on agent_jobs(session_id, created_at_ms asc, id asc);

create index idx_agent_jobs_recovery
  on agent_jobs(status, lease_expires_at_ms)
  where status in ('running', 'resuming');

create table agent_plans (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  job_id text not null unique references agent_jobs(id) on delete cascade,
  title text not null,
  goal text not null,
  status text not null check (
    status in ('active', 'completed', 'failed', 'cancelled')
  ),
  version integer not null default 0 check (version >= 0),
  metadata jsonb,
  created_at_ms bigint not null,
  updated_at_ms bigint not null,
  completed_at_ms bigint
);

create index idx_agent_plans_session
  on agent_plans(session_id, created_at_ms asc, id asc);

create table agent_plan_steps (
  id text primary key,
  plan_id text not null references agent_plans(id) on delete cascade,
  key text not null,
  position integer not null check (position >= 0),
  title text not null,
  description text,
  status text not null check (
    status in ('pending', 'in_progress', 'completed', 'failed', 'skipped')
  ),
  result jsonb,
  error_code text,
  error_message text,
  error_details jsonb,
  version integer not null default 0 check (version >= 0),
  metadata jsonb,
  created_at_ms bigint not null,
  updated_at_ms bigint not null,
  completed_at_ms bigint,
  unique (plan_id, key),
  unique (plan_id, position),
  check (result is null or jsonb_typeof(result) = 'object')
);

create index idx_agent_plan_steps_status
  on agent_plan_steps(plan_id, status, position asc);

create table agent_messages (
  row_id bigserial primary key,
  id text not null unique,
  session_id text not null references agent_sessions(id) on delete cascade,
  job_id text not null references agent_jobs(id) on delete cascade,
  plan_id text references agent_plans(id) on delete set null,
  plan_step_id text references agent_plan_steps(id) on delete set null,
  attempt_id text,
  output_id text,

  role text not null check (role in ('system', 'user', 'assistant', 'tool')),
  message_type text not null check (
    message_type in (
      'user_message',
      'assistant_message',
      'tool_call',
      'tool_result',
      'system_prompt',
      'progress',
      'error_notice',
      'code_artifact'
    )
  ),
  visibility text not null check (visibility in ('ui', 'internal')),
  channel text check (channel is null or channel in ('normal', 'progress', 'final')),
  content text not null,

  tool_calls jsonb,
  tool_call_id text,
  tool_name text,
  tool_result jsonb,
  metadata jsonb,
  created_at_ms bigint not null,

  check (
    (
      message_type = 'tool_call'
      and role = 'assistant'
      and tool_calls is not null
      and jsonb_typeof(tool_calls) = 'array'
      and jsonb_array_length(tool_calls) > 0
    )
    or message_type <> 'tool_call'
  ),
  check (
    (
      message_type = 'tool_result'
      and role = 'tool'
      and tool_call_id is not null
      and tool_name is not null
      and tool_result is not null
    )
    or message_type <> 'tool_result'
  ),
  check (
    (message_type = 'user_message' and role = 'user')
    or (message_type in (
      'assistant_message',
      'tool_call',
      'progress',
      'error_notice',
      'code_artifact'
    ) and role = 'assistant')
    or (message_type = 'system_prompt' and role = 'system')
    or (message_type = 'tool_result' and role = 'tool')
  ),
  check (
    message_type <> 'system_prompt' or (role = 'system' and visibility = 'internal')
  )
);

create index idx_agent_messages_session_cursor
  on agent_messages(session_id, row_id asc);

create index idx_agent_messages_job_cursor
  on agent_messages(job_id, row_id asc);

create index idx_agent_messages_plan_step
  on agent_messages(plan_id, plan_step_id, row_id asc)
  where plan_id is not null;

create index idx_agent_messages_visible
  on agent_messages(session_id, visibility, row_id asc);

create unique index uniq_agent_messages_job_output
  on agent_messages(job_id, output_id)
  where output_id is not null;

create table agent_tool_invocations (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  job_id text not null references agent_jobs(id) on delete cascade,
  plan_id text references agent_plans(id) on delete set null,
  plan_step_id text references agent_plan_steps(id) on delete set null,
  attempt_id text not null,

  call_message_id text not null references agent_messages(id) on delete restrict,
  result_message_id text references agent_messages(id) on delete restrict,
  tool_call_id text not null,
  tool_name text not null,
  arguments jsonb not null check (jsonb_typeof(arguments) = 'object'),
  arguments_checksum text not null,

  side_effect_level text not null check (
    side_effect_level in ('read_only', 'idempotent', 'side_effecting')
  ),
  idempotency_key text not null,
  status text not null check (
    status in (
      'pending',
      'running',
      'waiting_user_input',
      'completed',
      'failed',
      'unknown',
      'cancelled'
    )
  ),

  result_payload jsonb,
  error_code text,
  error_message text,
  error_details jsonb,
  version integer not null default 0 check (version >= 0),
  metadata jsonb,

  created_at_ms bigint not null,
  started_at_ms bigint,
  completed_at_ms bigint,
  updated_at_ms bigint not null,

  unique (job_id, tool_call_id),
  unique (job_id, idempotency_key),
  check (
    (status in ('completed', 'failed') and result_message_id is not null and completed_at_ms is not null)
    or status not in ('completed', 'failed')
  )
);

create index idx_agent_tool_invocations_recovery
  on agent_tool_invocations(status, updated_at_ms)
  where status in ('pending', 'running', 'unknown', 'waiting_user_input');

create index idx_agent_tool_invocations_plan_step
  on agent_tool_invocations(plan_step_id, created_at_ms asc)
  where plan_step_id is not null;

create table agent_artifacts (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  job_id text not null references agent_jobs(id) on delete cascade,
  plan_id text references agent_plans(id) on delete set null,
  plan_step_id text references agent_plan_steps(id) on delete set null,
  tool_invocation_id text not null references agent_tool_invocations(id) on delete restrict,
  result_message_id text not null references agent_messages(id) on delete restrict,
  kind text not null check (kind in ('file')),
  area text not null check (area in ('code', 'docs', 'artifacts', 'downloads')),
  title text not null,
  file_name text not null,
  logical_path text not null,
  storage_path text not null,
  media_type text not null,
  size bigint not null check (size >= 0),
  checksum text not null,
  revision integer not null check (revision > 0),
  metadata jsonb,
  created_at_ms bigint not null,
  unique (session_id, logical_path, revision),
  unique (tool_invocation_id, storage_path)
);

create index idx_agent_artifacts_session
  on agent_artifacts(session_id, created_at_ms asc, id asc);

create index idx_agent_artifacts_tool_invocation
  on agent_artifacts(tool_invocation_id, created_at_ms asc, id asc);

create table agent_user_input_requests (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  job_id text not null references agent_jobs(id) on delete cascade,
  plan_id text references agent_plans(id) on delete set null,
  plan_step_id text references agent_plan_steps(id) on delete set null,
  tool_invocation_id text references agent_tool_invocations(id) on delete restrict,

  source text not null check (source in ('tool', 'agent', 'recovery')),
  answer_mode text not null check (answer_mode in ('as_tool_result', 'as_user_message')),
  status text not null check (status in ('pending', 'answered', 'cancelled', 'expired')),

  title text,
  prompt text not null,
  input_schema jsonb not null check (jsonb_typeof(input_schema) = 'object'),
  answer jsonb,
  answer_message_id text references agent_messages(id) on delete restrict,
  client_answer_id text,

  version integer not null default 0 check (version >= 0),
  metadata jsonb,
  created_at_ms bigint not null,
  updated_at_ms bigint not null,
  answered_at_ms bigint,

  check (
    (source = 'tool' and tool_invocation_id is not null and answer_mode = 'as_tool_result')
    or source <> 'tool'
  ),
  check (
    (
      status = 'answered'
      and answer is not null
      and answer_message_id is not null
      and client_answer_id is not null
      and answered_at_ms is not null
    )
    or status <> 'answered'
  )
);

create unique index uniq_agent_user_input_tool_invocation
  on agent_user_input_requests(tool_invocation_id)
  where tool_invocation_id is not null;

create unique index uniq_agent_user_input_client_answer
  on agent_user_input_requests(job_id, client_answer_id)
  where client_answer_id is not null;

create index idx_agent_user_inputs_job_pending
  on agent_user_input_requests(job_id, status, created_at_ms asc);

create index idx_agent_user_inputs_plan_step_pending
  on agent_user_input_requests(plan_step_id, status, created_at_ms asc)
  where plan_step_id is not null;

create table agent_context_summaries (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  job_id text references agent_jobs(id) on delete cascade,

  owner_type text not null check (
    owner_type in ('session', 'job')
  ),
  owner_id text not null,
  purpose text not null check (
    purpose in ('conversation', 'job_execution')
  ),
  context_rules_version text not null,
  summary_type text not null check (
    summary_type in (
      'rolling',
      'job',
      'tool_history',
      'workspace_invariants',
      'workspace_index',
      'working_set'
    )
  ),
  status text not null check (status in ('active', 'superseded', 'failed')),

  source_row_id_start bigint not null,
  source_row_id_end bigint not null,
  parent_summary_id text references agent_context_summaries(id) on delete set null,
  replaces_summary_id text references agent_context_summaries(id) on delete set null,

  summary text not null,
  summary_format text not null check (summary_format in ('markdown', 'json')),
  source_message_count integer not null check (source_message_count >= 0),
  source_token_count integer,
  summary_token_count integer,
  model text,
  compression_prompt_version text not null,
  checksum text not null,
  version integer not null default 0 check (version >= 0),
  metadata jsonb,
  created_at_ms bigint not null,
  updated_at_ms bigint not null,

  check (source_row_id_start <= source_row_id_end),
  check (
    (owner_type = 'session' and owner_id = session_id and job_id is null)
    or (owner_type = 'job' and owner_id = job_id and job_id is not null)
  )
);

create unique index uniq_agent_context_summaries_active
  on agent_context_summaries(
    owner_type,
    owner_id,
    purpose,
    context_rules_version,
    summary_type
  )
  where status = 'active';

create index idx_agent_context_summaries_lookup
  on agent_context_summaries(
    owner_type,
    owner_id,
    purpose,
    status,
    source_row_id_end desc
  );

create table agent_model_calls (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  job_id text not null references agent_jobs(id) on delete cascade,
  attempt_id text not null,

  logical_call_key text not null,
  call_attempt_no integer not null check (call_attempt_no > 0),
  call_type text not null check (
    call_type in (
      'job.react',
      'context.compress'
    )
  ),
  status text not null check (status in ('started', 'completed', 'failed', 'cancelled')),

  provider text not null,
  model text not null,
  context_rules_version text not null,
  input_manifest jsonb not null,
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
  output_disposition text check (
    output_disposition in ('pending', 'accepted', 'rejected')
  ),
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

  unique (job_id, logical_call_key, call_attempt_no),
  check (
    (status in ('completed', 'failed', 'cancelled') and completed_at_ms is not null)
    or status = 'started'
  )
);

create index idx_agent_model_calls_session
  on agent_model_calls(session_id, created_at_ms desc, id asc);

create index idx_agent_model_calls_job
  on agent_model_calls(job_id, created_at_ms asc, id asc);

create unique index uniq_agent_model_calls_job_output
  on agent_model_calls(job_id, output_id)
  where output_id is not null;

create index idx_agent_model_calls_incomplete
  on agent_model_calls(status, created_at_ms asc)
  where status = 'started';

create unique index uniq_agent_model_calls_active_logical_call
  on agent_model_calls(job_id, logical_call_key)
  where status = 'started';

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
  warning_level text not null check (warning_level in ('normal', 'high', 'critical')),
  version integer not null default 0 check (version >= 0),
  updated_at_ms bigint not null
);
`;

export const AGENT_RUNTIME_SCHEMA_V1_CHECKSUM = createHash('sha256')
  .update(AGENT_RUNTIME_SCHEMA_V1_SQL)
  .digest('hex');

export async function applyAgentRuntimeSchemaV1(
  client: PoolClient,
  appliedAtMs: number
): Promise<void> {
  await client.query('begin');
  try {
    await client.query(AGENT_RUNTIME_SCHEMA_V1_SQL);
    await client.query(
      `insert into agent_schema_versions(version, name, checksum, applied_at_ms)
       values ($1, $2, $3, $4)
       on conflict (version) do nothing`,
      [
        AGENT_RUNTIME_SCHEMA_VERSION,
        AGENT_RUNTIME_SCHEMA_NAME,
        AGENT_RUNTIME_SCHEMA_V1_CHECKSUM,
        appliedAtMs,
      ]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
