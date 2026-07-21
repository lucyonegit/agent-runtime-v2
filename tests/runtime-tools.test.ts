import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isToolMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RuntimeTool,
  RuntimeToolContext,
  RuntimeUserInputArtifact,
} from '../src/runtime/tool-executor.js';
import { isPrivateAddress, isTextMediaType } from '../src/tools/browser-tools.js';
import { createRuntimeTools, removeSessionSandbox } from '../src/tools/index.js';
import { jsonToolOutput } from '../src/tools/tool-utils.js';

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
      'grep_files',
      'list_symbols',
      'run_shell',
      'browse_url',
      'web_search',
    ]);
    expect(new Set(tools.map(item => item.tool.name)).size).toBe(tools.length);
    expect(tools.filter(item => item.requiresFreshContext).map(item => item.tool.name))
      .toEqual(['write_article', 'write_file', 'run_shell']);
    expect(tools.filter(item => item.exclusive).map(item => item.tool.name))
      .toEqual(['run_shell']);
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

  it('shares the same categorized workspace across jobs in one session', async () => {
    await invoke('write_file', { path: 'code/app.ts', content: 'export const app = true;' });
    context = { ...context, jobId: 'job_2', toolCallId: 'call_2' };
    await expect(invoke('read_file', { path: 'code/app.ts' }))
      .resolves.toMatchObject({ content: expect.stringContaining('app') });
    await expect(readFile(
      join(sandboxRoot, 'sessions', 'session_1', 'workspace', 'code', 'app.ts'),
      'utf8'
    )).resolves.toContain('app');
  });

  it('runs shell commands in the workspace with structured output', async () => {
    if (process.platform !== 'darwin') return;
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

  it('returns non-zero shell exits and enforces timeout without turning them into tool failures', async () => {
    if (process.platform !== 'darwin') return;
    await expect(invoke('run_shell', {
      command: "printf 'bad command' >&2; exit 7",
    })).resolves.toMatchObject({ exitCode: 7, stderr: 'bad command', timedOut: false });
    await expect(invoke('run_shell', {
      command: 'sleep 5',
      timeoutMs: 100,
    })).resolves.toMatchObject({ timedOut: true });
  });

  it('terminates an in-flight shell process when the Job is cancelled', async () => {
    if (process.platform !== 'darwin') return;
    const controller = new AbortController();
    context = { ...context, signal: controller.signal };
    const running = invoke('run_shell', { command: 'sleep 20', timeoutMs: 120_000 });
    setTimeout(() => controller.abort(), 100).unref();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps runtime secrets and files outside the workspace unavailable to shell commands', async () => {
    if (process.platform !== 'darwin') return;
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-shell-outside-'));
    const outsideFile = join(outsideDirectory, 'secret.txt');
    await writeFile(outsideFile, 'do-not-read', 'utf8');
    const previous = process.env.AGENT_RUNTIME_SHELL_TEST_SECRET;
    process.env.AGENT_RUNTIME_SHELL_TEST_SECRET = 'do-not-expose';
    try {
      await expect(invoke('run_shell', {
        command: `test -z "$AGENT_RUNTIME_SHELL_TEST_SECRET"; env_exit=$?; cat '${outsideFile}'; read_exit=$?; exit $((env_exit || read_exit))`,
      })).resolves.toMatchObject({
        exitCode: 1,
        stdout: '',
        stderr: expect.stringContaining('Operation not permitted'),
      });
      await expect(invoke('run_shell', {
        command: `node -e 'const net=require("node:net"); net.connect(9,"127.0.0.1").on("error",error=>{ console.error(error.code); process.exit(error.code === "EPERM" ? 0 : 1); });'`,
      })).resolves.toMatchObject({
        exitCode: 0,
        stderr: expect.stringContaining('EPERM'),
      });
    } finally {
      if (previous === undefined) delete process.env.AGENT_RUNTIME_SHELL_TEST_SECRET;
      else process.env.AGENT_RUNTIME_SHELL_TEST_SECRET = previous;
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
