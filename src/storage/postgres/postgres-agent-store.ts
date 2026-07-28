import type { Pool } from 'pg';
import type {
  AgentStore,
  ContextStore,
  ExecutionStore,
  JobStore,
  ModelStore,
  PlanStore,
  SessionStore,
} from '../agent-store.js';
import { PostgresContextStore } from './stores/postgres-context-store.js';
import { PostgresExecutionStore } from './stores/postgres-execution-store.js';
import { PostgresJobStore } from './stores/postgres-job-store.js';
import { PostgresModelStore } from './stores/postgres-model-store.js';
import { PostgresPlanStore } from './stores/postgres-plan-store.js';
import { PostgresSessionStore } from './stores/postgres-session-store.js';

/** PostgreSQL composition root for the six persistence capabilities. */
export class PostgresAgentStore implements AgentStore {
  readonly sessions: SessionStore;
  readonly jobs: JobStore;
  readonly execution: ExecutionStore;
  readonly plans: PlanStore;
  readonly models: ModelStore;
  readonly context: ContextStore;

  constructor(pool: Pool) {
    this.sessions = new PostgresSessionStore(pool);
    this.jobs = new PostgresJobStore(pool);
    this.execution = new PostgresExecutionStore(pool);
    this.plans = new PostgresPlanStore(pool);
    this.models = new PostgresModelStore(pool);
    this.context = new PostgresContextStore(pool);
  }
}
