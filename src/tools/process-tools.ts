import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RuntimeTool } from '../runtime/tool-executor.js';
import { jsonToolOutput, numberArgument, runtimeContext, stringArgument } from './tool-utils.js';
import { stringRecord } from './process-environment.js';
import type { ManagedProcessManager } from './managed-process-manager.js';

export function createManagedProcessTools(manager: ManagedProcessManager): RuntimeTool[] {
  const startProcess = new DynamicStructuredTool({
    name: 'start_process',
    description: [
      'Start and supervise a persistent local development server in the Session workspace.',
      'Use this instead of run_shell for npm start, npm run dev, vite, next dev, and other commands that keep running.',
      'The Runtime allocates a free port when port is auto, waits until the TCP port is reachable, captures logs, and returns a stable processId and URL.',
      'Use {PORT} and {HOST} placeholders in the command or env values when the framework needs command-line arguments.',
      'Do not kill operating-system PIDs directly; use stop_process with the returned processId.',
    ].join(' '),
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120, description: 'Stable human-readable service name within the Session.' },
        command: { type: 'string', minLength: 1, maxLength: 20_000, description: 'Non-interactive server command executed with /bin/zsh.' },
        cwd: { type: 'string', default: '.', description: 'Working directory relative to the Session workspace, or an absolute directory.' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Explicit child environment. {PORT} and {HOST} placeholders are supported.' },
        host: { type: 'string', enum: ['127.0.0.1', 'localhost'], default: '127.0.0.1' },
        port: {
          anyOf: [
            { type: 'string', enum: ['auto'] },
            { type: 'integer', minimum: 1, maximum: 65535 },
          ],
          default: 'auto',
          description: 'Use auto unless the user explicitly requires a port.',
        },
        startupTimeoutMs: { type: 'integer', minimum: 1_000, maximum: 300_000, default: 60_000 },
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
        host: stringArgument(args, 'host', '127.0.0.1'),
        port,
        startupTimeoutMs: numberArgument(args, 'startupTimeoutMs', 60_000),
      });
      return jsonToolOutput(processRecord);
    },
  });

  const getProcess = new DynamicStructuredTool({
    name: 'get_process',
    description: 'Get the current live operating-system state of a process previously created by start_process.',
    schema: processIdSchema,
    responseFormat: 'content_and_artifact',
    func: async input => jsonToolOutput(await manager.getProcess(
      stringArgument(input as Record<string, unknown>, 'processId')
    )),
  });

  const readProcessLogs = new DynamicStructuredTool({
    name: 'read_process_logs',
    description: 'Read the newest captured stdout and stderr from a process created by start_process.',
    schema: {
      type: 'object',
      properties: {
        processId: { type: 'string', minLength: 1 },
        maxBytes: { type: 'integer', minimum: 1_024, maximum: 65_536, default: 32_768 },
      },
      required: ['processId'],
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async input => {
      const args = input as Record<string, unknown>;
      const processId = stringArgument(args, 'processId');
      const logs = await manager.readLogs(processId, numberArgument(args, 'maxBytes', 32_768));
      return jsonToolOutput({ processId, logs });
    },
  });

  const stopProcess = new DynamicStructuredTool({
    name: 'stop_process',
    description: 'Stop a process previously created by start_process. It is safe and idempotent and never targets an arbitrary operating-system PID.',
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

const processIdSchema = {
  type: 'object',
  properties: { processId: { type: 'string', minLength: 1 } },
  required: ['processId'],
  additionalProperties: false,
} as const;
