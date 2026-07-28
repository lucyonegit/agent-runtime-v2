import type { PoolClient } from 'pg';
import { AGENT_RUNTIME_TABLES, createAgentRuntimeSchema } from './schema.js';

export async function assertAgentRuntimeSchema(client: PoolClient): Promise<void> {
  const result = await client.query<{ table_name: string }>(
    `select table_name
     from information_schema.tables
     where table_schema = current_schema()
       and table_name like 'agent\_%' escape '\'
     order by table_name`
  );
  const existing = new Set(result.rows.map(row => row.table_name));
  const missing = AGENT_RUNTIME_TABLES.filter(table => !existing.has(table));
  const expected = new Set<string>(AGENT_RUNTIME_TABLES);
  const unexpected = [...existing].filter(table => !expected.has(table));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      [
        missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined,
        unexpected.length > 0 ? `unexpected legacy tables: ${unexpected.join(', ')}` : undefined,
      ].filter(Boolean).join('; ')
      + '. Run npm run schema:reset.'
    );
  }
}

export async function resetAgentRuntimeSchema(client: PoolClient): Promise<string[]> {
  await client.query('begin');
  try {
    const result = await client.query<{ tablename: string }>(
      `select tablename
       from pg_catalog.pg_tables
       where schemaname = current_schema()
         and tablename like 'agent\_%' escape '\'
       order by tablename`
    );
    const tableNames = result.rows.map(row => row.tablename);
    for (const tableName of tableNames) {
      await client.query(`drop table ${quoteIdentifier(tableName)} cascade`);
    }
    await createAgentRuntimeSchema(client);
    await client.query('commit');
    return tableNames;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
