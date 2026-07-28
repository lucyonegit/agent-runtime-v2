import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isToolMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TOOLS_CONFIG } from '../src/config/runtime-config.js';
import type {
  RuntimeTool,
  RuntimeToolContext,
  RuntimeUserInputArtifact,
} from '../src/runtime/execution/tool-executor.js';
import { isPrivateAddress, isTextMediaType } from '../src/tools/browser/browser-tools.js';
import {
  FILE_WRITE_MAX_CHARACTERS,
  FILE_WRITE_MAX_ESTIMATED_TOKENS,
} from '../src/tools/filesystem/filesystem-tools.js';
import { createRuntimeTools, removeSessionSandbox } from '../src/tools/index.js';
import { jsonToolOutput } from '../src/tools/helpers/tool-input.helper.js';

describe('LangChain runtime tools', () => {
  let sandboxRoot: string;
  let context: RuntimeToolContext;
  let tools: RuntimeTool[];

  beforeEach(async () => {
    sandboxRoot = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-tools-'));
    context = {
      sessionId: 'session_1',
      taskId: 'task_1',
      taskRunId: 'task_run_1',
      toolCallId: 'tool_call_1',
      modelToolCallId: 'model_call_1',
      idempotencyKey: 'idempotency_1',
      sandboxRoot,
    };
    tools = createRuntimeTools();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
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
      'start_file_write',
      'append_file_chunk',
      'grep_files',
      'list_symbols',
      'run_shell',
      'browse_url',
      'web_search',
    ]);
    expect(new Set(tools.map(item => item.tool.name)).size).toBe(tools.length);
    expect(tools.filter(item => item.requiresFreshContext).map(item => item.tool.name))
      .toEqual([
        'write_article',
        'write_file',
        'start_file_write',
        'append_file_chunk',
        'run_shell',
      ]);
    expect(tools.filter(item => item.exclusive).map(item => item.tool.name))
      .toEqual(['start_file_write', 'append_file_chunk', 'run_shell']);
  });

  it('runs basic tools through LangChain ToolCall and returns ToolMessage artifacts', async () => {
    await expect(invoke('calculate', { expression: '(2 + 3) * 4' }))
      .resolves.toMatchObject({ expression: '(2 + 3) * 4', result: 20 });
    await expect(invoke('get_current_time', { timeZone: 'Asia/Shanghai' }))
      .resolves.toMatchObject({ timeZone: 'Asia/Shanghai', iso: expect.any(String) });
    await expect(invoke('get_current_time', {}))
      .resolves.toMatchObject({ timeZone: 'Asia/Shanghai', iso: expect.any(String) });
    await expect(invoke('calculate', { expression: 'process.exit()' }))
      .rejects.toThrow('Only simple numeric expressions');
  });

  it('restores text, choice and multi-choice HITL schemas', async () => {
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

  it('rejects HITL schemas with impossible bounds or duplicate values', async () => {
    await expect(invoke('request_user_input', {
      prompt: 'Select values',
      input: {
        type: 'multi_choice',
        min: 2,
        max: 1,
        options: [{ label: 'One', value: 'one' }],
      },
    })).rejects.toThrow('selection bounds are invalid');
    await expect(invoke('request_user_input', {
      prompt: 'Select one',
      input: {
        type: 'single_choice',
        options: [
          { label: 'One', value: 'same' },
          { label: 'Again', value: 'same' },
        ],
      },
    })).rejects.toThrow('values must be unique');
  });

  it('writes artifacts inside the session artifact sandbox', async () => {
    const result = await invoke('write_article', {
      title: 'Hello/World',
      content: '# Hello',
      format: 'markdown',
    }) as { fileName: string; path: string; artifacts: Array<{ storagePath: string }> };
    expect(result.fileName).toBe('Hello_World.md');
    expect(result.path).toBe('artifacts/Hello_World.md');
    await expect(readFile(
      join(sandboxRoot, 'sessions', 'session_1', 'workspace', result.path),
      'utf8'
    )).resolves.toBe('# Hello');
    await expect(readFile(
      join(sandboxRoot, 'sessions', 'session_1', 'workspace', result.artifacts[0]!.storagePath),
      'utf8'
    )).resolves.toBe('# Hello');
  });

  it('routes source code to write_file and keeps write_article prose-only', async () => {
    const writeArticle = tools.find(item => item.tool.name === 'write_article')!.tool;
    const writeFile = tools.find(item => item.tool.name === 'write_file')!.tool;
    expect(writeArticle.description).toContain('Do not use for webpages or source code');
    expect(writeFile.description).toContain('webpages, applications, scripts, and source code');
    expect(JSON.stringify(writeArticle.schema)).not.toContain('html');

    await invoke('write_file', {
      path: 'code/index.html',
      content: '<!doctype html><title>Runtime</title>',
    });
    await expect(readFile(
      join(sandboxRoot, 'sessions', 'session_1', 'workspace', 'code', 'index.html'),
      'utf8'
    )).resolves.toContain('<title>Runtime</title>');
  });

  it('publishes and enforces the single-call file content limits', async () => {
    const writeFile = tools.find(item => item.tool.name === 'write_file')!;
    const writeArticle = tools.find(item => item.tool.name === 'write_article')!;
    expect(writeFile.tool.description).toContain(`${FILE_WRITE_MAX_CHARACTERS} characters`);
    expect(JSON.stringify(writeFile.tool.schema)).toContain(
      `"maxLength":${FILE_WRITE_MAX_CHARACTERS}`
    );
    expect(writeFile.argumentLimits).toEqual([expect.objectContaining({
      path: 'content',
      maxCharacters: FILE_WRITE_MAX_CHARACTERS,
      maxEstimatedTokens: FILE_WRITE_MAX_ESTIMATED_TOKENS,
      errorCode: 'file_content_too_large',
    })]);
    expect(JSON.stringify(writeArticle.tool.schema)).toContain(
      `"maxLength":${FILE_WRITE_MAX_CHARACTERS}`
    );
    expect(writeArticle.argumentLimits).toEqual([expect.objectContaining({
      path: 'content',
      maxEstimatedTokens: FILE_WRITE_MAX_ESTIMATED_TOKENS,
    })]);

    await expect(invoke('write_file', {
      path: 'code/too-large.ts',
      content: 'x'.repeat(FILE_WRITE_MAX_CHARACTERS + 1),
    })).rejects.toThrow();
    await expect(invoke('write_file', {
      path: 'docs/token-heavy.md',
      content: '中'.repeat(FILE_WRITE_MAX_ESTIMATED_TOKENS + 1),
    })).rejects.toMatchObject({ code: 'file_content_too_large' });
    await expect(invoke('write_article', {
      title: 'Too long',
      content: '中'.repeat(FILE_WRITE_MAX_ESTIMATED_TOKENS + 1),
      format: 'markdown',
    })).rejects.toMatchObject({ code: 'file_content_too_large' });
  });

  it('writes one large file in durable chunks and creates an Artifact only on finalize', async () => {
    const destination = join(
      sandboxRoot,
      'sessions',
      'session_1',
      'workspace',
      'code',
      'large.ts'
    );
    const started = await invoke('start_file_write', {
      path: 'code/large.ts',
      content: 'export const first = 1;\n',
    }) as {
      writeId: string;
      acceptedChunkIndex: number;
      nextChunkIndex: number;
      status: string;
      artifacts?: unknown[];
    };
    expect(started).toMatchObject({
      writeId: expect.stringMatching(/^file_write_[a-f0-9]{32}$/),
      acceptedChunkIndex: 0,
      nextChunkIndex: 1,
      status: 'open',
    });
    expect(started.artifacts).toBeUndefined();
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });

    context = {
      ...context,
      toolCallId: 'tool_call_2',
      modelToolCallId: 'model_call_2',
      idempotencyKey: 'idempotency_2',
    };
    const appended = await invoke('append_file_chunk', {
      writeId: started.writeId,
      chunkIndex: 1,
      content: 'export const second = 2;\n',
      finalize: false,
    }) as {
      acceptedChunkIndex: number;
      nextChunkIndex: number;
      status: string;
      artifacts?: unknown[];
    };
    expect(appended).toMatchObject({
      acceptedChunkIndex: 1,
      nextChunkIndex: 2,
      status: 'open',
    });
    expect(appended.artifacts).toBeUndefined();
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });

    // Staging state is filesystem-backed, so a new Runtime tool instance can continue it.
    tools = createRuntimeTools();
    context = {
      ...context,
      toolCallId: 'tool_call_3',
      modelToolCallId: 'model_call_3',
      idempotencyKey: 'idempotency_3',
    };
    const completed = await invoke('append_file_chunk', {
      writeId: started.writeId,
      chunkIndex: 2,
      content: 'export const third = 3;\n',
      finalize: true,
    }) as {
      status: string;
      acceptedChunkIndex: number;
      size: number;
      checksum: string;
      artifacts: Array<{ storagePath: string; metadata: Record<string, unknown> }>;
    };
    expect(completed).toMatchObject({
      status: 'completed',
      acceptedChunkIndex: 2,
      size: expect.any(Number),
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      artifacts: [expect.objectContaining({
        storagePath: '.revisions/tool_call_3/code/large.ts',
        metadata: expect.objectContaining({
          chunked: true,
          chunkCount: 3,
          writeId: started.writeId,
          snapshot: true,
        }),
      })],
    });
    const expected = [
      'export const first = 1;\n',
      'export const second = 2;\n',
      'export const third = 3;\n',
    ].join('');
    await expect(readFile(destination, 'utf8')).resolves.toBe(expected);
    await expect(readFile(
      join(
        sandboxRoot,
        'sessions',
        'session_1',
        'workspace',
        completed.artifacts[0]!.storagePath
      ),
      'utf8'
    )).resolves.toBe(expected);
  });

  it('makes accepted file chunks idempotent and rejects conflicts or gaps', async () => {
    const started = await invoke('start_file_write', {
      path: 'docs/chunked.md',
      content: 'zero',
    }) as { writeId: string };
    context = {
      ...context,
      toolCallId: 'tool_call_2',
      modelToolCallId: 'model_call_2',
      idempotencyKey: 'idempotency_2',
    };
    await expect(invoke('append_file_chunk', {
      writeId: started.writeId,
      chunkIndex: 2,
      content: 'gap',
      finalize: false,
    })).rejects.toMatchObject({ code: 'file_chunk_out_of_order' });
    await expect(invoke('append_file_chunk', {
      writeId: started.writeId,
      chunkIndex: 1,
      content: 'one',
      finalize: false,
    })).resolves.toMatchObject({ nextChunkIndex: 2 });
    await expect(invoke('append_file_chunk', {
      writeId: started.writeId,
      chunkIndex: 1,
      content: 'one',
      finalize: false,
    })).resolves.toMatchObject({ nextChunkIndex: 2, replayed: true });
    await expect(invoke('append_file_chunk', {
      writeId: started.writeId,
      chunkIndex: 1,
      content: 'different',
      finalize: false,
    })).rejects.toMatchObject({ code: 'file_chunk_conflict' });
  });

  it('reads, writes, lists, searches and indexes the session workspace', async () => {
    await invoke('write_file', {
      path: 'code/src/example.ts',
      content: 'export function hello() { return "runtime"; }\n',
    });
    await expect(invoke('read_file', { path: 'code/src/example.ts' }))
      .resolves.toMatchObject({ path: 'code/src/example.ts', content: expect.stringContaining('hello') });
    const listed = await invoke('list_files', { directory: '.', recursive: true }) as {
      files: Array<{ path: string }>;
    };
    expect(listed.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'code', isDirectory: true }),
      expect.objectContaining({ path: 'docs', isDirectory: true }),
      expect.objectContaining({ path: 'artifacts', isDirectory: true }),
      expect.objectContaining({ path: 'downloads', isDirectory: true }),
      expect.objectContaining({ path: 'tmp', isDirectory: true }),
      expect.objectContaining({ path: 'code/src/example.ts' }),
    ]));
    await expect(invoke('grep_files', { pattern: 'runtime' }))
      .resolves.toMatchObject({ totalMatches: 1, matches: [{ path: 'code/src/example.ts', line: 1 }] });
    await expect(invoke('list_symbols', {}))
      .resolves.toMatchObject({ symbols: [{ name: 'hello', kind: 'function', path: 'code/src/example.ts' }] });
  });

  it('shares the same categorized workspace across tasks in one session', async () => {
    await invoke('write_file', { path: 'code/app.ts', content: 'export const app = true;' });
    context = {
      ...context,
      taskId: 'task_2',
      toolCallId: 'tool_call_2',
      modelToolCallId: 'model_call_2',
    };
    await expect(invoke('read_file', { path: 'code/app.ts' }))
      .resolves.toMatchObject({ content: expect.stringContaining('app') });
    await expect(readFile(
      join(sandboxRoot, 'sessions', 'session_1', 'workspace', 'code', 'app.ts'),
      'utf8'
    )).resolves.toContain('app');
  });

  it('runs shell commands in the workspace with structured output', async () => {
    const result = await invoke('run_shell', {
      command: "printf 'hello' > code/shell.txt; printf 'stdout'; printf 'stderr' >&2",
    }) as {
      cwd: string;
      exitCode: number | null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
    };
    expect(result).toMatchObject({
      cwd: '.',
      exitCode: 0,
      timedOut: false,
      stdout: 'stdout',
      stderr: 'stderr',
    });
    await expect(readFile(
      join(sandboxRoot, 'sessions', 'session_1', 'workspace', 'code', 'shell.txt'),
      'utf8'
    )).resolves.toBe('hello');
  });

  it('turns non-zero shell exits and timeouts into stable tool failures', async () => {
    await expect(invoke('run_shell', {
      command: "printf 'bad command' >&2; exit 7",
    })).rejects.toMatchObject({
      code: 'shell_command_failed',
      details: expect.objectContaining({ exitCode: 7, stderr: 'bad command', timedOut: false }),
    });
    await expect(invoke('run_shell', {
      command: 'sleep 5',
      timeoutMs: 100,
    })).rejects.toMatchObject({
      code: 'shell_timeout',
      details: expect.objectContaining({ timedOut: true }),
    });
  });

  it('terminates an in-flight shell process when the Task is cancelled', async () => {
    const controller = new AbortController();
    context = { ...context, signal: controller.signal };
    const running = invoke('run_shell', { command: 'sleep 20', timeoutMs: 120_000 });
    setTimeout(() => controller.abort(), 100).unref();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps host filesystem and network access while isolating Runtime-only environment', async () => {
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-shell-outside-'));
    const outsideFile = join(outsideDirectory, 'host-file.txt');
    await writeFile(outsideFile, 'before', 'utf8');
    const server = createServer((_request, response) => response.end('network-ok'));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test HTTP server has no TCP port.');
    const toolsConfig = {
      ...structuredClone(DEFAULT_TOOLS_CONFIG),
      hostEnvironment: {
        PATH: process.env.PATH,
        LANG: 'C',
        AGENT_RUNTIME_SHELL_TEST_SECRET: 'runtime-secret',
        GITHUB_TOKEN: 'github-secret',
        AWS_ACCESS_KEY_ID: 'aws-secret',
      },
    };
    tools = createRuntimeTools({ config: toolsConfig });
    try {
      await expect(invoke('run_shell', {
        command: [
          `printf 'after' > '${outsideFile}'`,
          `printf '%s|%s|%s|%s|' "$LANG" "$AGENT_RUNTIME_SHELL_TEST_SECRET" "$GITHUB_TOKEN" "$AWS_ACCESS_KEY_ID"`,
          `cat '${outsideFile}'`,
          `printf '|'`,
          `/usr/bin/curl --fail --silent 'http://127.0.0.1:${address.port}/'`,
          `printf '|%s' "$WORKSPACE_EXPLICIT_VALUE"`,
        ].join('; '),
        env: { WORKSPACE_EXPLICIT_VALUE: 'explicit-value' },
      })).resolves.toMatchObject({
        exitCode: 0,
        stdout: 'C||||after|network-ok|explicit-value',
        stderr: '',
      });
      await expect(readFile(outsideFile, 'utf8')).resolves.toBe('after');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  it('removes the complete shared workspace when its session is deleted', async () => {
    await invoke('write_file', { path: 'docs/notes.md', content: 'session notes' });
    const sessionRoot = join(sandboxRoot, 'sessions', 'session_1');
    await expect(stat(sessionRoot)).resolves.toBeDefined();
    await removeSessionSandbox({ sandboxRoot, sessionId: 'session_1' });
    await expect(stat(sessionRoot)).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('allows proxy fake DNS addresses only through the explicit hostname path', async () => {
    expect(isPrivateAddress('198.18.2.210')).toBe(true);
    expect(isPrivateAddress('198.18.2.210', true)).toBe(false);
    expect(isPrivateAddress('127.0.0.1', true)).toBe(true);
    const previous = process.env.AGENT_RUNTIME_ALLOW_PROXY_FAKE_IPS;
    process.env.AGENT_RUNTIME_ALLOW_PROXY_FAKE_IPS = 'true';
    try {
      await expect(invoke('browse_url', { url: 'http://198.18.2.210/private' }))
        .rejects.toThrow('Private or unresolved network addresses');
    } finally {
      if (previous === undefined) delete process.env.AGENT_RUNTIME_ALLOW_PROXY_FAKE_IPS;
      else process.env.AGENT_RUNTIME_ALLOW_PROXY_FAKE_IPS = previous;
    }
  });

  it('rejects PDF responses before decoding the binary body', async () => {
    const text = vi.fn(async () => '%PDF-1.5\u0000binary');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      url: 'https://93.184.216.34/report.pdf',
      headers: new Headers({ 'content-type': 'application/pdf' }),
      text,
    })));

    await expect(invoke('browse_url', {
      url: 'https://93.184.216.34/report.pdf',
    })).rejects.toThrow('application/pdf');
    expect(text).not.toHaveBeenCalled();
  });

  it('accepts only explicit textual browser response media types', () => {
    expect(isTextMediaType('text/html; charset=utf-8')).toBe(true);
    expect(isTextMediaType('application/json')).toBe(true);
    expect(isTextMediaType('application/atom+xml')).toBe(true);
    expect(isTextMediaType('application/pdf')).toBe(false);
    expect(isTextMediaType('application/octet-stream')).toBe(false);
  });

  it('removes NUL characters from JSON tool content and artifacts', () => {
    const [content, artifact] = jsonToolOutput({
      'nul\u0000key': ['a\u0000b', { nested: '\u0000value\u0000' }],
    });
    expect(artifact).toEqual({ nulkey: ['ab', { nested: 'value' }] });
    expect(content).toBe('{"nulkey":["ab",{"nested":"value"}]}');
    expect(jsonToolOutput('a\u0000b')).toEqual(['"ab"', 'ab']);
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
