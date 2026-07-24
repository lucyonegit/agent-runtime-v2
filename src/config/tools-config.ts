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
    maximumReadBytes: number;
    maximumListEntries: number;
    maximumTraversalDepth: number;
    grepDefaultResults: number;
    grepMaximumResults: number;
    symbolsDefaultResults: number;
    symbolsMaximumResults: number;
    linePreviewCharacters: number;
    artifactTitleCharacters: number;
  };
  shell: {
    executable: string;
    defaultTimeoutMs: number;
    minimumTimeoutMs: number;
    maximumTimeoutMs: number;
    maximumOutputBytes: number;
    terminationGraceMs: number;
    maximumCommandCharacters: number;
  };
  managedProcesses: {
    defaultHost: string;
    allowedHosts: string[];
    portRangeStart: number;
    portRangeEnd: number;
    defaultStartupTimeoutMs: number;
    maximumStartupTimeoutMs: number;
    stopGraceMs: number;
    readinessPollMs: number;
    discoveryPollMs: number;
    maximumLogBytes: number;
    socketTimeoutMs: number;
    discoveryCommandMaximumBytes: number;
  };
  browser: {
    requestTimeoutMs: number;
    maximumRedirects: number;
    defaultContentCharacters: number;
    minimumContentCharacters: number;
    maximumContentCharacters: number;
    searchResultLimit: number;
    allowProxyFakeIps: boolean;
  };
  environment: {
    blockedKeys: string[];
    blockedPrefixes: string[];
    hostEnvironment?: NodeJS.ProcessEnv;
  };
}

export const DEFAULT_TOOLS_CONFIG: Readonly<ToolsConfig> = Object.freeze({
  enabled: {
    hitl: true,
    basic: true,
    artifacts: true,
    filesystem: true,
    shell: true,
    managedProcesses: true,
    browser: true,
  },
  filesystem: {
    maximumWriteCharacters: 6_000,
    maximumWriteEstimatedTokens: 2_000,
    maximumReadBytes: 1_048_576,
    maximumListEntries: 10_000,
    maximumTraversalDepth: 50,
    grepDefaultResults: 50,
    grepMaximumResults: 200,
    symbolsDefaultResults: 100,
    symbolsMaximumResults: 500,
    linePreviewCharacters: 300,
    artifactTitleCharacters: 120,
  },
  shell: {
    executable: '/bin/zsh',
    defaultTimeoutMs: 300_000,
    minimumTimeoutMs: 100,
    maximumTimeoutMs: 1_800_000,
    maximumOutputBytes: 32 * 1_024,
    terminationGraceMs: 1_000,
    maximumCommandCharacters: 20_000,
  },
  managedProcesses: {
    defaultHost: '127.0.0.1',
    allowedHosts: ['127.0.0.1', 'localhost'],
    portRangeStart: 4_100,
    portRangeEnd: 4_999,
    defaultStartupTimeoutMs: 60_000,
    maximumStartupTimeoutMs: 300_000,
    stopGraceMs: 1_500,
    readinessPollMs: 100,
    discoveryPollMs: 1_000,
    maximumLogBytes: 64 * 1_024,
    socketTimeoutMs: 250,
    discoveryCommandMaximumBytes: 4 * 1_024 * 1_024,
  },
  browser: {
    requestTimeoutMs: 30_000,
    maximumRedirects: 5,
    defaultContentCharacters: 5_000,
    minimumContentCharacters: 500,
    maximumContentCharacters: 20_000,
    searchResultLimit: 5,
    allowProxyFakeIps: false,
  },
  environment: {
    blockedKeys: [
      'DATABASE_URL',
      'DASHSCOPE_API_KEY',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
    ],
    blockedPrefixes: ['AGENT_RUNTIME_', 'AGENT_SERVER_'],
  },
});
