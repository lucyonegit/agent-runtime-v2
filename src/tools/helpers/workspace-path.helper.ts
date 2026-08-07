import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { RuntimeToolContext } from '../../runtime/execution/tool-executor.js';

const SESSION_WORKSPACE_AREAS = [
  'code',
  'docs',
  'artifacts',
  'downloads',
  'tmp',
] as const;

type SessionWorkspaceArea = typeof SESSION_WORKSPACE_AREAS[number];

function sessionWorkspaceRoot(
  context: Pick<RuntimeToolContext, 'sandboxRoot' | 'sessionId'>
): string {
  assertSafeId(context.sessionId, 'session');
  return resolve(context.sandboxRoot, 'sessions', context.sessionId, 'workspace');
}

function workspaceAreaRoot(
  context: Pick<RuntimeToolContext, 'sandboxRoot' | 'sessionId'>,
  area: SessionWorkspaceArea
): string {
  return resolve(sessionWorkspaceRoot(context), area);
}

export async function workspaceRoot(
  context: Pick<RuntimeToolContext, 'sandboxRoot' | 'sessionId'>
): Promise<string> {
  const root = sessionWorkspaceRoot(context);
  await mkdir(root, { recursive: true });
  await Promise.all(SESSION_WORKSPACE_AREAS.map(area => (
    mkdir(workspaceAreaRoot(context, area), { recursive: true })
  )));
  return root;
}

export async function resolveWorkspacePath(
  context: Pick<RuntimeToolContext, 'sandboxRoot' | 'sessionId'>,
  userPath: string,
  options: { mustExist?: boolean } = {}
): Promise<string> {
  return resolveContainedPath(await workspaceRoot(context), userPath, options);
}

export async function resolveExistingWorkspacePath(
  context: Pick<RuntimeToolContext, 'sandboxRoot' | 'sessionId'>,
  userPath: string
): Promise<string> {
  return resolveContainedPath(sessionWorkspaceRoot(context), userPath, { mustExist: true });
}

export async function resolveWorkspaceAreaPath(
  context: Pick<RuntimeToolContext, 'sandboxRoot' | 'sessionId'>,
  area: SessionWorkspaceArea,
  userPath: string,
  options: { mustExist?: boolean } = {}
): Promise<string> {
  await workspaceRoot(context);
  return resolveContainedPath(workspaceAreaRoot(context, area), userPath, options);
}

export async function removeSessionSandbox(input: {
  sandboxRoot: string;
  sessionId: string;
}): Promise<void> {
  assertSafeId(input.sessionId, 'session');
  await rm(resolve(input.sandboxRoot, 'sessions', input.sessionId), {
    recursive: true,
    force: true,
  });
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
