import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReactCoreToolContext } from '../src/core/index.js';
import { createCodeFilesystemTools } from '../src/tools/code-filesystem-tools.js';

describe('code filesystem tools', () => {
  let root: string;
  let context: ReactCoreToolContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-code-tools-'));
    context = {
      sessionId: 'session_1',
      taskId: 'task_1',
      sandboxRoot: root,
      projectId: 'project_1',
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('registers the code project file tool set', () => {
    expect(createCodeFilesystemTools().map(tool => tool.name)).toEqual([
      'list_files',
      'read_file',
      'write_file',
      'grep_files',
      'list_symbols',
    ]);
  });

  it('writes files under the code project root with stable change records', async () => {
    const writeFileTool = findTool('write_file');

    await expect(writeFileTool.execute({
      path: 'src/App.tsx',
      content: 'export function App() { return null; }\n',
    }, context)).resolves.toMatchObject({
      type: 'completed',
      result: {
        path: 'src/App.tsx',
        projectId: 'project_1',
        changes: [{
          path: 'src/App.tsx',
          operation: 'created',
        }],
      },
    });
    await expect(readFile(join(root, 'code-projects', 'project_1', 'src', 'App.tsx'), 'utf-8'))
      .resolves.toBe('export function App() { return null; }\n');
  });

  it('reads, lists, and searches files under the code project root', async () => {
    const writeFileTool = findTool('write_file');
    const readFileTool = findTool('read_file');
    const listFilesTool = findTool('list_files');
    const grepFilesTool = findTool('grep_files');
    await writeFileTool.execute({
      path: 'src/App.tsx',
      content: 'export function App() {\n  return "target";\n}\n',
    }, context);

    await expect(readFileTool.execute({ path: 'src/App.tsx' }, context)).resolves.toMatchObject({
      type: 'completed',
      result: {
        path: 'src/App.tsx',
        content: 'export function App() {\n  return "target";\n}\n',
      },
    });
    await expect(listFilesTool.execute({ directory: 'src', recursive: true }, context)).resolves.toMatchObject({
      type: 'completed',
      result: {
        directory: 'src',
        files: [{ path: 'src/App.tsx', isDirectory: false }],
      },
    });
    await expect(grepFilesTool.execute({ pattern: 'target' }, context)).resolves.toMatchObject({
      type: 'completed',
      result: {
        totalMatches: 1,
        matches: [{ path: 'src/App.tsx', line: 2 }],
      },
    });
  });

  it('lists basic TypeScript symbols from the project', async () => {
    const writeFileTool = findTool('write_file');
    const listSymbolsTool = findTool('list_symbols');
    await writeFileTool.execute({
      path: 'src/App.tsx',
      content: 'export function App() {}\nclass LocalView {}\nconst value = 1;\n',
    }, context);

    await expect(listSymbolsTool.execute({ directory: 'src' }, context)).resolves.toMatchObject({
      type: 'completed',
      result: {
        symbols: [
          { name: 'App', kind: 'function', path: 'src/App.tsx', line: 1 },
          { name: 'LocalView', kind: 'class', path: 'src/App.tsx', line: 2 },
          { name: 'value', kind: 'constant', path: 'src/App.tsx', line: 3 },
        ],
      },
    });
  });

  it('requires project id and rejects paths escaping the project', async () => {
    const writeFileTool = findTool('write_file');

    await expect(writeFileTool.execute({
      path: 'src/App.tsx',
      content: '',
    }, { ...context, projectId: undefined })).resolves.toMatchObject({
      type: 'failed',
      error: expect.stringContaining('projectId is required'),
    });
    await expect(writeFileTool.execute({
      path: '../escape.ts',
      content: '',
    }, context)).resolves.toMatchObject({
      type: 'failed',
      error: expect.stringContaining('Code project path escapes'),
    });
  });
});

function findTool(name: string) {
  const tool = createCodeFilesystemTools().find(item => item.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  return tool;
}
