import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isToolMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  RuntimeTool,
  RuntimeToolContext,
  RuntimeUserInputArtifact,
} from '../src/runtime/tool-executor.js';
import { createRuntimeTools } from '../src/tools/index.js';

describe('LangChain runtime tools', () => {
  let sandboxRoot: string;
  let context: RuntimeToolContext;
  let tools: RuntimeTool[];

  beforeEach(async () => {
    sandboxRoot = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-tools-'));
    context = {
      sessionId: 'session_1',
      jobId: 'job_1',
      attemptId: 'attempt_1',
      toolInvocationId: 'invocation_1',
      toolCallId: 'call_1',
      idempotencyKey: 'idempotency_1',
      sandboxRoot,
    };
    tools = createRuntimeTools();
  });

  afterEach(async () => {
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it('restores the complete general and code-capable tool set', () => {
    expect(tools.map(item => item.tool.name)).toEqual([
      'request_user_input',
      'get_current_time',
      'calculate',
      'write_article',
      'list_files',
      'read_file',
      'write_file',
      'grep_files',
      'list_symbols',
      'browse_url',
      'web_search',
    ]);
    expect(new Set(tools.map(item => item.tool.name)).size).toBe(tools.length);
  });

  it('runs basic tools through LangChain ToolCall and returns ToolMessage artifacts', async () => {
    await expect(invoke('calculate', { expression: '(2 + 3) * 4' }))
      .resolves.toMatchObject({ expression: '(2 + 3) * 4', result: 20 });
    await expect(invoke('get_current_time', { timeZone: 'Asia/Shanghai' }))
      .resolves.toMatchObject({ timeZone: 'Asia/Shanghai', iso: expect.any(String) });
    await expect(invoke('calculate', { expression: 'process.exit()' }))
      .rejects.toThrow('Only simple numeric expressions');
  });

  it('restores text, choice, multi-choice and approval HITL schemas', async () => {
    const artifact = await invoke('request_user_input', {
      title: 'Choose',
      prompt: 'Select one',
      sensitive: true,
      input: {
        type: 'single_choice',
        options: [{ label: 'One', value: 'one' }],
      },
    }) as RuntimeUserInputArtifact;
    expect(artifact).toEqual({
      type: 'requires_user_input',
      request: {
        source: 'tool',
        answerMode: 'as_tool_result',
        title: 'Choose',
        prompt: 'Select one',
        sensitiveAnswer: true,
        inputSchema: {
          type: 'single_choice',
          options: [{ label: 'One', value: 'one' }],
        },
      },
    });
  });

  it('writes artifacts inside the session artifact sandbox', async () => {
    const result = await invoke('write_article', {
      title: 'Hello/World',
      content: '# Hello',
      format: 'markdown',
    }) as { fileName: string; path: string };
    expect(result.fileName).toBe('Hello_World.md');
    expect(result.path).toContain(join('sessions', 'session_1', 'artifacts'));
    await expect(readFile(result.path, 'utf8')).resolves.toBe('# Hello');
  });

  it('reads, writes, lists, searches and indexes the session workspace', async () => {
    await invoke('write_file', {
      path: 'src/example.ts',
      content: 'export function hello() { return "runtime"; }\n',
    });
    await expect(invoke('read_file', { path: 'src/example.ts' }))
      .resolves.toMatchObject({ path: 'src/example.ts', content: expect.stringContaining('hello') });
    const listed = await invoke('list_files', { directory: '.', recursive: true }) as {
      files: Array<{ path: string }>;
    };
    expect(listed.files).toContainEqual(expect.objectContaining({ path: 'src/example.ts' }));
    await expect(invoke('grep_files', { pattern: 'runtime' }))
      .resolves.toMatchObject({ totalMatches: 1, matches: [{ path: 'src/example.ts', line: 1 }] });
    await expect(invoke('list_symbols', {}))
      .resolves.toMatchObject({ symbols: [{ name: 'hello', kind: 'function', path: 'src/example.ts' }] });
  });

  it('routes filesystem tools to a code project sandbox when projectId is present', async () => {
    context = { ...context, projectId: 'project_1' };
    const result = await invoke('write_file', { path: 'app.ts', content: 'export const app = true;' }) as {
      projectId: string;
    };
    expect(result.projectId).toBe('project_1');
    await expect(readFile(
      join(sandboxRoot, 'code-projects', 'project_1', 'app.ts'),
      'utf8'
    )).resolves.toContain('app');
  });

  it('blocks traversal, symlink escapes and private browser targets', async () => {
    await expect(invoke('write_file', { path: '../escape.txt', content: 'no' }))
      .rejects.toThrow('escapes');
    const outside = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-outside-'));
    try {
      await invoke('write_file', { path: 'safe.txt', content: 'safe' });
      await symlink(outside, join(sandboxRoot, 'sessions', 'session_1', 'workspace', 'link'));
      await expect(invoke('write_file', { path: 'link/escape.txt', content: 'no' }))
        .rejects.toThrow('escapes');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    await expect(invoke('browse_url', { url: 'http://127.0.0.1:3000/private' }))
      .rejects.toThrow('Private or unresolved network addresses');
  });

  async function invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    const runtimeTool = tools.find(item => item.tool.name === name);
    if (!runtimeTool) throw new Error(`Missing test tool: ${name}`);
    const output = await runtimeTool.tool.invoke({
      type: 'tool_call',
      id: context.toolCallId,
      name,
      args,
    }, {
      configurable: { agentRuntimeContext: context },
    });
    if (!isToolMessage(output)) throw new Error(`${name} did not return a ToolMessage.`);
    return output.artifact;
  }
});
