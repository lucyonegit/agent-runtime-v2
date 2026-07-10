import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createRuntimeTools,
  createPlannerStepRuntimeTools,
  createCodeRuntimeTools,
  createOpenAIToolDefinitions,
} from '../src/tools/index.js';
import type { ReactCoreToolContext } from '../src/core/index.js';

describe('runtime tools', () => {
  let root: string;
  let context: ReactCoreToolContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-tools-'));
    context = {
      sessionId: 'session_1',
      taskId: 'task_1',
      sandboxRoot: root,
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('registers the first sandboxed Manus-style tool set', () => {
    const tools = createRuntimeTools();

    expect(tools.map(tool => tool.name)).toEqual([
      'request_user_input',
      'get_current_time',
      'calculate',
      'write_article',
      'list_files',
      'read_file',
      'write_file',
      'grep_files',
      'browse_url',
      'web_search',
    ]);
    expect(createOpenAIToolDefinitions(tools).map(tool => tool.function.name)).toEqual(
      tools.map(tool => tool.name)
    );
  });

  it('creates a generic HITL input request from request_user_input', async () => {
    const requestUserInput = findTool('request_user_input');

    await expect(requestUserInput.execute({
      title: '确认优化方向',
      prompt: '你希望我优先优化性能还是 UI？',
      input: {
        type: 'single_choice',
        options: [
          { label: '性能', value: 'performance' },
          { label: 'UI', value: 'ui' },
        ],
      },
    }, context)).resolves.toEqual({
      type: 'requires_user_input',
      request: {
        source: 'tool',
        resumeMode: 'answer_as_tool_result',
        title: '确认优化方向',
        prompt: '你希望我优先优化性能还是 UI？',
        input: {
          type: 'single_choice',
          options: [
            { label: '性能', value: 'performance' },
            { label: 'UI', value: 'ui' },
          ],
        },
      },
    });
  });

  it('registers request_user_input for code runtime tools too', () => {
    expect(createCodeRuntimeTools().map(tool => tool.name)).toContain('request_user_input');
  });

  it('isolates planner step completion from general and code runtimes', () => {
    expect(createRuntimeTools().map(tool => tool.name)).not.toEqual(expect.arrayContaining([
      'create_plan',
      'update_plan',
      'set_plan_step_status',
      'submit_step_result',
    ]));
    expect(createCodeRuntimeTools().map(tool => tool.name)).not.toEqual(expect.arrayContaining([
      'create_plan',
      'update_plan',
      'set_plan_step_status',
      'submit_step_result',
    ]));
    expect(createPlannerStepRuntimeTools().map(tool => tool.name)).toEqual([
      ...createRuntimeTools().map(tool => tool.name),
      'submit_step_result',
    ]);
  });

  it('writes article artifacts inside the session artifacts sandbox', async () => {
    const writeArticle = findTool('write_article');
    const result = await writeArticle.execute({
      title: 'Hello/World',
      content: '# Hello',
      format: 'markdown',
    }, context);

    expect(result.type).toBe('completed');
    if (result.type !== 'completed') {
      throw new Error('expected completed result');
    }
    expect(result.result).toMatchObject({
      title: 'Hello/World',
      fileName: 'Hello_World.md',
      format: 'markdown',
      area: 'artifacts',
    });
    const artifactPath = join(root, 'sessions', 'session_1', 'artifacts', 'Hello_World.md');
    await expect(readFile(artifactPath, 'utf-8')).resolves.toBe('# Hello');
  });

  it('reads and writes workspace files inside the session workspace sandbox', async () => {
    const writeFileTool = findTool('write_file');
    const readFileTool = findTool('read_file');

    await expect(writeFileTool.execute({
      path: 'notes/todo.md',
      content: '- one',
    }, context)).resolves.toMatchObject({
      type: 'completed',
      result: {
        path: 'notes/todo.md',
        area: 'workspace',
      },
    });

    await expect(readFileTool.execute({ path: 'notes/todo.md' }, context)).resolves.toMatchObject({
      type: 'completed',
      result: {
        path: 'notes/todo.md',
        content: '- one',
      },
    });
  });

  it('rejects file writes that escape the workspace sandbox', async () => {
    const writeFileTool = findTool('write_file');

    await expect(writeFileTool.execute({
      path: '../escape.md',
      content: 'bad',
    }, context)).resolves.toMatchObject({
      type: 'failed',
      error: expect.stringContaining('Sandbox path escapes'),
    });
  });

  it('searches workspace files with grep_files', async () => {
    const writeFileTool = findTool('write_file');
    const grepFiles = findTool('grep_files');
    await writeFileTool.execute({
      path: 'notes/todo.md',
      content: 'alpha\nbeta target\n',
    }, context);

    await expect(grepFiles.execute({
      pattern: 'target',
      maxResults: 5,
    }, context)).resolves.toMatchObject({
      type: 'completed',
      result: {
        totalMatches: 1,
        matches: [{
          path: 'notes/todo.md',
          line: 2,
          content: 'beta target',
        }],
      },
    });
  });
});

function findTool(name: string) {
  const tool = createRuntimeTools().find(item => item.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  return tool;
}
