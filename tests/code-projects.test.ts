import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSessionStore } from '../src/storage/index.js';
import {
  createCodeProjectSandbox,
  ensureCodeProjectRoot,
  resolveCodeProjectPath,
} from '../src/code-agent/project-sandbox.js';

describe('code projects', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-code-projects-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores code project metadata outside the sandbox filesystem', async () => {
    const store = new FileSessionStore(root);
    await store.createSession({ id: 'session_1', mode: 'code', now: 100 });

    const project = await store.createCodeProject({
      id: 'project_1',
      sessionId: 'session_1',
      title: 'Demo App',
      status: 'active',
      sandboxRelativePath: 'code-projects/project_1',
      framework: 'react',
      language: 'typescript',
      packageManager: 'pnpm',
      now: 110,
    });

    expect(project).toMatchObject({
      id: 'project_1',
      sessionId: 'session_1',
      sandboxRelativePath: 'code-projects/project_1',
      framework: 'react',
    });
    await expect(store.getCodeProject('project_1')).resolves.toMatchObject({
      id: 'project_1',
      title: 'Demo App',
    });
    await expect(store.listCodeProjects('session_1')).resolves.toMatchObject([
      { id: 'project_1', updatedAt: 110 },
    ]);
  });

  it('resolves code project paths under code-projects by project id', async () => {
    const sandbox = createCodeProjectSandbox({
      sandboxRoot: root,
      projectId: 'project_1',
    });

    await expect(ensureCodeProjectRoot(sandbox)).resolves.toBe(join(root, 'code-projects', 'project_1'));
    await expect(resolveCodeProjectPath(sandbox, 'src/App.tsx')).resolves.toBe(
      join(root, 'code-projects', 'project_1', 'src', 'App.tsx')
    );
  });

  it('rejects absolute and traversal paths for code project files', async () => {
    const sandbox = createCodeProjectSandbox({
      sandboxRoot: root,
      projectId: 'project_1',
    });

    await expect(resolveCodeProjectPath(sandbox, '/tmp/escape.ts')).rejects.toThrow(
      'Code project path must be relative'
    );
    await expect(resolveCodeProjectPath(sandbox, '../escape.ts')).rejects.toThrow(
      'Code project path escapes'
    );
  });
});
