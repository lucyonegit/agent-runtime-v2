import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { ReactCoreToolContext } from '../core/index.js';
import { createSandbox, ensureSandboxArea, resolveSandboxPath } from './sandbox.js';
import type { RuntimeTool } from './types.js';
import { completedJson, failed, numberArg, stringArg } from './types.js';

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
}

export function createFilesystemTools(): RuntimeTool[] {
  return [
    {
      name: 'list_files',
      description: 'List files and directories inside the session workspace sandbox.',
      parameters: {
        type: 'object',
        properties: {
          directory: {
            type: 'string',
            description: 'Workspace-relative directory to list. Defaults to workspace root.',
          },
          recursive: {
            type: 'boolean',
            description: 'Whether to recursively list nested files. Defaults to false.',
          },
        },
        additionalProperties: false,
      },
      execute: async (args, context) => withToolError(async () => {
        const directory = stringArg(args, 'directory', '.');
        const recursive = args.recursive === true;
        const workspace = await workspaceRoot(context);
        const target = directory === '.' || directory.trim() === ''
          ? workspace
          : await resolveSandboxPath(createSandboxFor(context), 'workspace', directory, { mustExist: true });
        const files = await listFiles(target, workspace, recursive);
        return completedJson({ directory: directory === '.' ? '/' : directory, files });
      }),
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the session workspace sandbox.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async (args, context) => withToolError(async () => {
        const path = stringArg(args, 'path');
        const filePath = await resolveSandboxPath(createSandboxFor(context), 'workspace', path, { mustExist: true });
        const content = await readFile(filePath, 'utf-8');
        return completedJson({ path, content });
      }),
    },
    {
      name: 'write_file',
      description: 'Write a UTF-8 text file inside the session workspace sandbox.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          content: { type: 'string', description: 'File content.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      execute: async (args, context) => withToolError(async () => {
        const path = stringArg(args, 'path');
        const content = stringArg(args, 'content');
        const filePath = await resolveSandboxPath(createSandboxFor(context), 'workspace', path);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, content, 'utf-8');
        return completedJson({
          path,
          area: 'workspace',
          size: Buffer.byteLength(content, 'utf-8'),
        });
      }),
    },
    {
      name: 'grep_files',
      description: 'Search workspace text files with a JavaScript regular expression.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search string or JavaScript regular expression.' },
          directory: { type: 'string', description: 'Workspace-relative directory. Defaults to workspace root.' },
          maxResults: { type: 'number', description: 'Maximum number of matches. Defaults to 50.' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      execute: async (args, context) => withToolError(async () => {
        const pattern = stringArg(args, 'pattern');
        const directory = stringArg(args, 'directory', '.');
        const maxResults = Math.max(1, Math.min(200, numberArg(args, 'maxResults', 50)));
        const workspace = await workspaceRoot(context);
        const target = directory === '.' || directory.trim() === ''
          ? workspace
          : await resolveSandboxPath(createSandboxFor(context), 'workspace', directory, { mustExist: true });
        const regex = new RegExp(pattern, 'i');
        const matches = await grepFiles(target, workspace, regex, maxResults);
        return completedJson({ pattern, totalMatches: matches.length, matches });
      }),
    },
  ];
}

function createSandboxFor(context: ReactCoreToolContext) {
  return createSandbox({ root: context.sandboxRoot, sessionId: context.sessionId });
}

async function workspaceRoot(context: ReactCoreToolContext): Promise<string> {
  return ensureSandboxArea(createSandboxFor(context), 'workspace');
}

async function withToolError<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

async function listFiles(root: string, workspace: string, recursive: boolean): Promise<FileEntry[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: FileEntry[] = [];
  for (const entry of entries) {
    if (shouldSkip(entry.name)) {
      continue;
    }
    const fullPath = join(root, entry.name);
    const itemStat = await stat(fullPath);
    const item: FileEntry = {
      name: entry.name,
      path: normalizeRelative(workspace, fullPath),
      isDirectory: entry.isDirectory(),
      size: entry.isDirectory() ? undefined : itemStat.size,
    };
    result.push(item);
    if (recursive && entry.isDirectory()) {
      result.push(...await listFiles(fullPath, workspace, true));
    }
  }
  return result;
}

async function grepFiles(
  root: string,
  workspace: string,
  regex: RegExp,
  maxResults: number
): Promise<Array<{ path: string; line: number; content: string }>> {
  const matches: Array<{ path: string; line: number; content: string }> = [];
  await walk(root, async filePath => {
    if (matches.length >= maxResults) {
      return;
    }
    const content = await readFile(filePath, 'utf-8').catch(() => undefined);
    if (content === undefined) {
      return;
    }
    const lines = content.split('\n');
    for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
      const line = lines[index];
      if (regex.test(line)) {
        matches.push({
          path: normalizeRelative(workspace, filePath),
          line: index + 1,
          content: line.trim().slice(0, 300),
        });
      }
    }
  });
  return matches;
}

async function walk(root: string, visit: (filePath: string) => Promise<void>): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldSkip(entry.name)) {
      continue;
    }
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, visit);
    } else if (entry.isFile()) {
      await visit(fullPath);
    }
  }
}

function shouldSkip(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === 'dist' || name.startsWith('.');
}

function normalizeRelative(root: string, value: string): string {
  return relative(root, value).split('\\').join('/');
}
