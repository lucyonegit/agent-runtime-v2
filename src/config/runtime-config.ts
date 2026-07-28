import 'dotenv/config';
import {
  DASHSCOPE_OPENAI_BASE_URL,
  resolveModelTokenLimits,
  type ModelProvider,
  type ModelTokenOverrides,
  type ResolvedModelTokenLimits,
} from '../runtime/model/model-profiles.js';
import {
  bundledRuntimeConfigPath,
  deepFreeze,
  loadRuntimeConfigFile,
  readBundledRuntimeConfigFile,
} from './runtime-config.helper.js';
import type { HttpToolCapability } from './runtime-capabilities.js';

export {
  DASHSCOPE_OPENAI_BASE_URL,
  resolveModelTokenLimits,
};
export type {
  HttpToolCapability,
  ModelProvider,
  ModelTokenOverrides,
  ResolvedModelTokenLimits,
};

export type ServerLogLevel = 'error' | 'warn' | 'log' | 'debug' | 'verbose';

export interface ServerConfig {
  host: string;
  port: number;
  authToken: string;
  debugEndpointsEnabled: boolean;
  toolCapabilities: HttpToolCapability[];
  logger: ServerLogLevel[];
  cors: {
    origin: string[];
    credentials: boolean;
    methods: string[];
    allowedHeaders: string[];
  };
}

export interface PostgresConfig {
  url: string;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  ssl: boolean;
}

export interface ModelConfig {
  provider: ModelProvider;
  apiKey: string;
  baseURL: string;
  modelName: string;
  temperature: number;
  streaming: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  tokens: ModelTokenOverrides;
}

export interface ExecutionConfig {
  maxIterations: number;
  maxToolCalls: number;
  deadlineMs: number;
  ownershipTimeoutMs: number;
  ownershipRefreshMs: number;
  recoveryScanIntervalMs: number;
  recoveryBatchSize: number;
}

export interface ContextConfig {
  keepRecentInputTokens: number;
  maxToolResultTokens: number;
  summaryMaxTokens: number;
}

export interface ToolsConfig {
  enabled: {
    hitl: boolean;
    basic: boolean;
    artifacts: boolean;
    filesystem: boolean;
    shell: boolean;
    managedProcesses: boolean;
    browser: boolean;
  };
  filesystem: {
    maximumWriteCharacters: number;
    maximumWriteEstimatedTokens: number;
  };
  shell: {
    executable: string;
    defaultTimeoutMs: number;
    maximumTimeoutMs: number;
  };
  managedProcesses: {
    portRangeStart: number;
    portRangeEnd: number;
    defaultStartupTimeoutMs: number;
    maximumStartupTimeoutMs: number;
  };
  browser: {
    requestTimeoutMs: number;
    allowProxyFakeIps: boolean;
  };
  hostEnvironment?: NodeJS.ProcessEnv;
}

export interface RuntimeConfigFile {
  runtime: {
    workerId: string;
    sandboxRoot: string;
  };
  server: ServerConfig;
  postgres: PostgresConfig;
  model: ModelConfig;
  execution: ExecutionConfig;
  context: ContextConfig;
  tools: ToolsConfig;
}

export interface RuntimeConfig {
  workerId: string;
  sandboxRoot: string;
  server: ServerConfig;
  postgres: PostgresConfig;
  model: ModelConfig;
  modelTokenLimits: ResolvedModelTokenLimits;
  execution: ExecutionConfig;
  context: ContextConfig;
  tools: ToolsConfig;
}

export interface LoadRuntimeConfigOptions {
  env?: NodeJS.ProcessEnv;
  configFile?: string;
}

const bundledDefaults = readBundledRuntimeConfigFile();

export const DEFAULT_SERVER_CONFIG =
  deepFreeze(structuredClone(bundledDefaults.server));
export const DEFAULT_POSTGRES_CONFIG =
  deepFreeze(structuredClone(bundledDefaults.postgres));
export const DEFAULT_MODEL_CONFIG =
  deepFreeze(structuredClone(bundledDefaults.model));
export const DEFAULT_EXECUTION_CONFIG =
  deepFreeze(structuredClone(bundledDefaults.execution));
export const DEFAULT_CONTEXT_CONFIG =
  deepFreeze(structuredClone(bundledDefaults.context));
export const DEFAULT_TOOLS_CONFIG =
  deepFreeze(structuredClone(bundledDefaults.tools));

/**
 * The only public boundary allowed to read deployment configuration.
 *
 * Precedence is: src/config/runtime.json < optional JSON override < environment.
 * The bundled JSON is the sole default-value source; environment variables
 * supply secrets and narrowly scoped deployment overrides.
 */
export function loadRuntimeConfig(
  options: LoadRuntimeConfigOptions = {}
): Readonly<RuntimeConfig> {
  const env = options.env ?? process.env;
  const configFile = options.configFile
    ?? env.AGENT_RUNTIME_CONFIG_FILE
    ?? bundledRuntimeConfigPath();
  const config = loadRuntimeConfigFile(configFile, env);
  const workerId = config.runtime.workerId === 'auto'
    ? `worker_${process.pid}`
    : config.runtime.workerId;
  return deepFreeze({
    workerId,
    sandboxRoot: config.runtime.sandboxRoot,
    server: config.server,
    postgres: config.postgres,
    model: config.model,
    modelTokenLimits: resolveModelTokenLimits(config.model),
    execution: config.execution,
    context: config.context,
    tools: {
      ...config.tools,
      hostEnvironment: { ...env },
    },
  });
}
