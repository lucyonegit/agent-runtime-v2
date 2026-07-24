export type ServerLogLevel = 'error' | 'warn' | 'log' | 'debug' | 'verbose';

export interface ServerConfig {
  host: string;
  port: number;
  logger: ServerLogLevel[];
  cors: {
    origin: true | string[];
    credentials: boolean;
    methods: string[];
    allowedHeaders: string[];
  };
}

const DEFAULTS: ServerConfig = {
  host: '127.0.0.1',
  port: 3_000,
  logger: ['error', 'warn', 'log'],
  cors: {
    origin: true,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type'],
  },
};

export const DEFAULT_SERVER_CONFIG: Readonly<ServerConfig> = Object.freeze(DEFAULTS);
