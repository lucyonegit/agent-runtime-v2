/**
 * The launcher is materialized beside each local process spec. Keeping the
 * source as data makes both compiled Runtime builds and source-level tests use
 * exactly the same dependency-free supervisor.
 */
export const WORKSPACE_PROCESS_SUPERVISOR_SOURCE = String.raw`
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const processId = requiredArgument('--agent-runtime-process-id');
const sessionId = requiredArgument('--agent-runtime-session-id');
const ownershipToken = requiredArgument('--agent-runtime-owner-token');
const specPath = resolve(requiredArgument('--agent-runtime-spec'));
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
if (
  spec.schemaVersion !== 1
  || spec.id !== processId
  || spec.sessionId !== sessionId
  || spec.ownershipToken !== ownershipToken
) {
  throw new Error('Workspace process supervisor identity does not match its local spec.');
}

const logFd = openSync(spec.absoluteLogPath, 'a', 0o600);
const child = spawn('/bin/zsh', ['-f', '-c', spec.command], {
  cwd: spec.cwd,
  env: process.env,
  detached: false,
  stdio: ['ignore', logFd, logFd],
});
let finished = false;
child.once('error', error => finish(null, null, error.message));
child.once('close', (exitCode, signal) => finish(exitCode, signal, undefined));

function finish(exitCode, signal, errorMessage) {
  if (finished) return;
  finished = true;
  closeSync(logFd);
  const exitPath = resolve(specPath, '..', 'exit.json');
  try {
    writeFileSync(exitPath, JSON.stringify({
      processId,
      exitCode,
      signal,
      ...(errorMessage ? { errorMessage } : {}),
      completedAtMs: Date.now(),
    }), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Exit status is a local diagnostic; process termination must not depend on it.
  }
  process.exit(errorMessage ? 1 : exitCode ?? (signal ? 1 : 0));
}

function requiredArgument(name) {
  const prefix = name + '=';
  const value = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error('Missing ' + name + '.');
  return value;
}
`;
