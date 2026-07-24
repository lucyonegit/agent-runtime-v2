export interface PostgresConfig {
  url: string;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  ssl: boolean;
}

export const DEFAULT_POSTGRES_CONFIG: Readonly<PostgresConfig> = Object.freeze({
  url: '',
  maxConnections: 10,
  idleTimeoutMs: 30_000,
  connectionTimeoutMs: 10_000,
  ssl: false,
});
