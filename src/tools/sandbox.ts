import { mkdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export type SandboxArea = 'workspace' | 'artifacts' | 'downloads' | 'tmp';

export interface ToolSandbox {
  root: string;
  sessionId: string;
}

export interface ResolveSandboxPathOptions {
  mustExist?: boolean;
}

export function createSandbox(input: { root: string; sessionId: string }): ToolSandbox {
  const sessionId = input.sessionId.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) {
    throw new Error(`Invalid sandbox session id: ${input.sessionId}`);
  }
  return {
    root: resolve(input.root),
    sessionId,
  };
}

export async function ensureSandboxArea(sandbox: ToolSandbox, area: SandboxArea): Promise<string> {
  const areaRoot = getAreaRoot(sandbox, area);
  await mkdir(areaRoot, { recursive: true });
  return areaRoot;
}

export async function resolveSandboxPath(
  sandbox: ToolSandbox,
  area: SandboxArea,
  userPath: string,
  options: ResolveSandboxPathOptions = {}
): Promise<string> {
  if (!userPath || userPath.trim() === '') {
    throw new Error('Sandbox path is required');
  }
  if (isAbsolute(userPath)) {
    throw new Error('Sandbox path must be relative');
  }

  const areaRoot = await ensureSandboxArea(sandbox, area);
  const candidate = resolve(areaRoot, userPath);
  assertInside(areaRoot, candidate);

  if (options.mustExist) {
    const [realAreaRoot, realCandidate] = await Promise.all([
      realpath(areaRoot),
      realpath(candidate),
    ]);
    assertInside(realAreaRoot, realCandidate);
  }

  return candidate;
}

export function getSandboxSessionRoot(sandbox: ToolSandbox): string {
  return resolve(sandbox.root, 'sessions', sandbox.sessionId);
}

export async function removeSessionSandbox(input: { root: string; sessionId: string }): Promise<void> {
  const sandbox = createSandbox(input);
  await rm(getSandboxSessionRoot(sandbox), { recursive: true, force: true });
}

export function getAreaRoot(sandbox: ToolSandbox, area: SandboxArea): string {
  return resolve(getSandboxSessionRoot(sandbox), area);
}

function assertInside(root: string, candidate: string): void {
  const relation = relative(root, candidate);
  if (relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))) {
    return;
  }
  throw new Error(`Sandbox path escapes ${root}: ${candidate}`);
}
