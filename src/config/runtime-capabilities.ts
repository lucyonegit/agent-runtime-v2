export const HTTP_TOOL_CAPABILITIES = [
  'artifacts',
  'filesystem',
  'shell',
  'managedProcesses',
  'browser',
] as const;

export type HttpToolCapability = typeof HTTP_TOOL_CAPABILITIES[number];
