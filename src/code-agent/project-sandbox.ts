import { mkdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export interface CodeProjectSandbox {
  sandboxRoot: string;
  projectId: string;
}

export interface ResolveCodeProjectPathOptions {
  mustExist?: boolean;
}

export function createCodeProjectSandbox(input: {
  sandboxRoot: string;
  projectId: string;
}): CodeProjectSandbox {
  const projectId = input.projectId.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(projectId)) {
    throw new Error(`Invalid code project id: ${input.projectId}`);
  }
  return {
    sandboxRoot: resolve(input.sandboxRoot),
    projectId,
  };
}

export function getCodeProjectRelativePath(projectId: string): string {
  const sandbox = createCodeProjectSandbox({ sandboxRoot: '.', projectId });
  return ['code-projects', sandbox.projectId].join('/');
}

export async function ensureCodeProjectRoot(sandbox: CodeProjectSandbox): Promise<string> {
  const root = getCodeProjectRoot(sandbox);
  await mkdir(root, { recursive: true });
  return root;
}

export async function removeCodeProjectSandbox(input: {
  sandboxRoot: string;
  projectId: string;
}): Promise<void> {
  const sandbox = createCodeProjectSandbox(input);
  await rm(getCodeProjectRoot(sandbox), { recursive: true, force: true });
}

export async function resolveCodeProjectPath(
  sandbox: CodeProjectSandbox,
  userPath: string,
  options: ResolveCodeProjectPathOptions = {}
): Promise<string> {
  if (!userPath || userPath.trim() === '') {
    throw new Error('Code project path is required');
  }
  if (isAbsolute(userPath)) {
    throw new Error('Code project path must be relative');
  }

  const root = await ensureCodeProjectRoot(sandbox);
  const candidate = resolve(root, userPath);
  assertInside(root, candidate);

  if (options.mustExist) {
    const [realRoot, realCandidate] = await Promise.all([
      realpath(root),
      realpath(candidate),
    ]);
    assertInside(realRoot, realCandidate);
  }

  return candidate;
}

export function getCodeProjectRoot(sandbox: CodeProjectSandbox): string {
  return resolve(sandbox.sandboxRoot, 'code-projects', sandbox.projectId);
}

function assertInside(root: string, candidate: string): void {
  const relation = relative(root, candidate);
  if (relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))) {
    return;
  }
  throw new Error(`Code project path escapes ${root}: ${candidate}`);
}
