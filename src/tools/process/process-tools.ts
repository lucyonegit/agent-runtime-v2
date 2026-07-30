import { DynamicStructuredTool } from '@langchain/core/tools';
import {
  DEFAULT_TOOLS_CONFIG,
  type ToolsConfig,
} from '../../config/runtime-config.js';
import type { RuntimeTool } from '../../runtime/execution/tool-executor.js';
import {
  jsonToolOutput,
  numberArgument,
  runtimeContext,
  stringArgument,
} from '../helpers/tool-input.helper.js';
import { stringRecord } from './helpers/process-environment.helper.js';
import {
  resolveManagedProcessToolConfig,
  type ManagedProcessManager,
} from './managed-process-manager.js';

export function createManagedProcessTools(
  manager: ManagedProcessManager,
  processOptions: ToolsConfig['managedProcesses'] =
    DEFAULT_TOOLS_CONFIG.managedProcesses
): RuntimeTool[] {
  const processConfig = resolveManagedProcessToolConfig(processOptions);
  const startProcess = new DynamicStructuredTool({
    name: 'start_process',
    description: [
      'Start and supervise a persistent local development server in the Session workspace.',
      'Use this instead of run_shell for npm start, npm run dev, vite, next dev, and other commands that keep running.',
      'The Runtime allocates a free port when port is auto, waits until the TCP port is reachable, captures logs, and returns a stable processId and URL.',
      'When port is auto, the command or an explicit env value must contain {PORT}; the Runtime rejects ambiguous commands before starting them.',
      'For Vite, use: npm run dev -- --host {HOST} --port {PORT}. For an env-driven server, use: PORT={PORT} HOST={HOST} npm start.',
      'A failed start exposes structured details with the exact process.id and captured log tail; use that evidence instead of guessing a process identifier.',
      'Do not kill operating-system PIDs directly; use stop_process with the returned processId.',
    ].join(' '),
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120, description: 'Stable human-readable service name within the Session.' },
        command: { type: 'string', minLength: 1, maxLength: 20_000, description: 'Non-interactive development-server command.' },
        cwd: { type: 'string', default: '.', description: 'Working directory relative to the Session workspace, or an absolute directory.' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Explicit child environment. {PORT} and {HOST} placeholders are supported.' },
        host: {
          type: 'string',
          enum: processConfig.allowedHosts,
          default: processConfig.defaultHost,
        },
        port: {
          anyOf: [
            { type: 'string', enum: ['auto'] },
            { type: 'integer', minimum: 1, maximum: 65535 },
          ],
          default: 'auto',
          description: 'Use auto unless the user explicitly requires a port. Auto requires {PORT} in command or an explicit env value.',
        },
        startupTimeoutMs: {
          type: 'integer',
          minimum: 1_000,
          maximum: processConfig.maximumStartupTimeoutMs,
          default: processConfig.defaultStartupTimeoutMs,
        },
      },
      required: ['name', 'command'],
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async (input, _runManager, config) => {
      const args = input as Record<string, unknown>;
      const requestedPort = args.port;
      const port = typeof requestedPort === 'number' ? requestedPort : 'auto';
      const processRecord = await manager.startProcess({
        context: runtimeContext(config),
        name: stringArgument(args, 'name'),
        command: stringArgument(args, 'command'),
        cwd: stringArgument(args, 'cwd', '.'),
        env: stringRecord(args.env, 'env'),
        host: stringArgument(args, 'host', processConfig.defaultHost),
        port,
        startupTimeoutMs: numberArgument(
          args,
          'startupTimeoutMs',
          processConfig.defaultStartupTimeoutMs
        ),
      });
      return jsonToolOutput(processRecord);
    },
  });

  const getProcess = new DynamicStructuredTool({
    name: 'get_process',
    description: 'Get current state using the exact processId returned by start_process. Never pass the human-readable name or an operating-system PID.',
    schema: processIdSchema,
    responseFormat: 'content_and_artifact',
    func: async input => jsonToolOutput(await manager.getProcess(
      stringArgument(input as Record<string, unknown>, 'processId')
    )),
  });

  const readProcessLogs = new DynamicStructuredTool({
    name: 'read_process_logs',
    description: 'Read captured logs using the exact processId returned in a successful or failed start_process result. Never pass the human-readable name or an operating-system PID.',
    schema: {
      type: 'object',
      properties: {
        processId: processIdProperty,
        maxBytes: {
          type: 'integer',
          minimum: 1_024,
          maximum: processConfig.maximumLogBytes,
          default: Math.min(32_768, processConfig.maximumLogBytes),
        },
      },
      required: ['processId'],
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async input => {
      const args = input as Record<string, unknown>;
      const processId = stringArgument(args, 'processId');
      const logs = await manager.readLogs(
        processId,
        numberArgument(
          args,
          'maxBytes',
          Math.min(32_768, processConfig.maximumLogBytes)
        )
      );
      return jsonToolOutput({ processId, logs });
    },
  });

  const stopProcess = new DynamicStructuredTool({
    name: 'stop_process',
    description: 'Stop a process using the exact processId returned by start_process. It is safe and idempotent, and never accepts a human-readable name or arbitrary operating-system PID.',
    schema: processIdSchema,
    responseFormat: 'content_and_artifact',
    func: async input => jsonToolOutput(await manager.stopProcess(
      stringArgument(input as Record<string, unknown>, 'processId')
    )),
  });

  return [
    { tool: startProcess, sideEffectLevel: 'side_effecting', exclusive: true, requiresFreshContext: true },
    { tool: getProcess, sideEffectLevel: 'read_only' },
    { tool: readProcessLogs, sideEffectLevel: 'read_only' },
    { tool: stopProcess, sideEffectLevel: 'idempotent', exclusive: true, requiresFreshContext: true },
  ];
}

const processIdProperty = {
  type: 'string',
  pattern: '^process_[a-f0-9]{32}$',
  description: 'Exact opaque processId returned by start_process, such as process_0123456789abcdef0123456789abcdef. A process name or OS PID is invalid.',
} as const;

const processIdSchema = {
  type: 'object',
  properties: { processId: processIdProperty },
  required: ['processId'],
  additionalProperties: false,
} as const;
