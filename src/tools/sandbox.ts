import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { RuntimeToolContext } from '../runtime/tool-executor.js';

export type SessionSandboxArea = 'workspace' | 'artifacts' | 'downloads' | 'tmp';

export function sessionAreaRoot(
  context: Pick<RuntimeToolContext, 'sandboxRoot' | 'sessionId'>,
  area: SessionSandboxArea
): string {
  assertSafeId(context.sessionId, 'session');
  return resolve(context.sandboxRoot, 'sessions', context.sessionId, area);
}

export function codeProjectRoot(
  context: Pick<RuntimeToolContext, 'sandboxRoot' | 'projectId'>
): string {
  if (!context.projectId) throw new Error('projectId is required for a code project sandbox.');
  assertSafeId(context.projectId, 'code project');
  return resolve(context.sandboxRoot, 'code-projects', context.projectId);
}

export async function workspaceRoot(context: RuntimeToolContext): Promise<string> {
  const root = context.projectId
    ? codeProjectRoot(context)
    : sessionAreaRoot(context, 'workspace');
  await mkdir(root, { recursive: true });
  return root;
}

export async function resolveWorkspacePath(
  context: RuntimeToolContext,
  userPath: string,
  options: { mustExist?: boolean } = {}
): Promise<string> {
  return resolveContainedPath(await workspaceRoot(context), userPath, options);
}

export async function resolveSessionAreaPath(
  context: RuntimeToolContext,
  area: Exclude<SessionSandboxArea, 'workspace'>,
  userPath: string,
  options: { mustExist?: boolean } = {}
): Promise<string> {
  const root = sessionAreaRoot(context, area);
  await mkdir(root, { recursive: true });
  return resolveContainedPath(root, userPath, options);
}

export async function removeSessionSandbox(input: {
  sandboxRoot: string;
  sessionId: string;
}): Promise<void> {
  const root = sessionAreaRoot(input, 'workspace');
  await rm(resolve(root, '..'), { recursive: true, force: true });
}

export async function removeCodeProjectSandbox(input: {
  sandboxRoot: string;
  projectId: string;
}): Promise<void> {
  await rm(codeProjectRoot(input), { recursive: true, force: true });
}

async function resolveContainedPath(
  root: string,
  userPath: string,
  options: { mustExist?: boolean }
): Promise<string> {
  if (!userPath.trim()) throw new Error('Sandbox path is required.');
  if (isAbsolute(userPath)) throw new Error('Sandbox path must be relative.');
  const candidate = resolve(root, userPath);
  assertInside(root, candidate);
  const realRoot = await realpath(root);
  const canonicalCandidate = resolve(realRoot, relative(root, candidate));
  assertInside(realRoot, canonicalCandidate);
  if (options.mustExist) {
    assertInside(realRoot, await realpath(canonicalCandidate));
    return canonicalCandidate;
  }
  const existingParent = await nearestExistingPath(dirname(canonicalCandidate), realRoot);
  assertInside(realRoot, await realpath(existingParent));
  return canonicalCandidate;
}

async function nearestExistingPath(candidate: string, boundary: string): Promise<string> {
  let current = candidate;
  while (true) {
    if (await lstat(current).then(() => true, () => false)) return current;
    if (current === boundary) return current;
    const parent = dirname(current);
    assertInside(boundary, parent);
    current = parent;
  }
}

function assertSafeId(value: string, type: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value.trim())) {
    throw new Error(`Invalid ${type} id: ${value}`);
  }
}

function assertInside(root: string, candidate: string): void {
  const relation = relative(root, candidate);
  if (relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))) return;
  throw new Error(`Sandbox path escapes ${root}: ${candidate}`);
}
