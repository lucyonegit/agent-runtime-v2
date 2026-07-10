import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSandbox,
  ensureSandboxArea,
  resolveSandboxPath,
} from '../src/tools/sandbox.js';

describe('tool sandbox', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-sandbox-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('resolves relative paths inside the requested session area', async () => {
    const sandbox = createSandbox({ root, sessionId: 'session_1' });
    const resolved = await resolveSandboxPath(sandbox, 'workspace', 'notes/report.md');

    expect(resolved).toBe(join(root, 'sessions', 'session_1', 'workspace', 'notes', 'report.md'));
  });

  it('creates sandbox areas under the session directory', async () => {
    const sandbox = createSandbox({ root, sessionId: 'session_1' });

    await expect(ensureSandboxArea(sandbox, 'artifacts')).resolves.toBe(
      join(root, 'sessions', 'session_1', 'artifacts')
    );
  });

  it('rejects absolute paths', async () => {
    const sandbox = createSandbox({ root, sessionId: 'session_1' });

    await expect(resolveSandboxPath(sandbox, 'workspace', '/tmp/escape.txt')).rejects.toThrow(
      'Sandbox path must be relative'
    );
  });

  it('rejects traversal outside the sandbox area', async () => {
    const sandbox = createSandbox({ root, sessionId: 'session_1' });

    await expect(resolveSandboxPath(sandbox, 'workspace', '../escape.txt')).rejects.toThrow(
      'Sandbox path escapes'
    );
  });

  it('rejects symlink escapes when reading an existing path', async () => {
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'secret', 'utf-8');

    const sandbox = createSandbox({ root, sessionId: 'session_1' });
    const workspace = await ensureSandboxArea(sandbox, 'workspace');
    const symlinkPath = join(workspace, 'outside-link.txt');
    await import('node:fs/promises').then(fs => fs.symlink(outside, symlinkPath));

    await expect(resolveSandboxPath(sandbox, 'workspace', 'outside-link.txt', {
      mustExist: true,
    })).rejects.toThrow('Sandbox path escapes');
  });
});
