import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import type { ReactCoreToolContext } from '../core/index.js';
import {
  createCodeProjectSandbox,
  ensureCodeProjectRoot,
  resolveCodeProjectPath,
} from '../code-agent/project-sandbox.js';
import type { RuntimeTool } from './types.js';
import { completedJson, failed, numberArg, stringArg } from './types.js';

type CodeFileOperation = 'created' | 'updated';

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
}

interface CodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'constant';
  path: string;
  line: number;
}

export function createCodeFilesystemTools(): RuntimeTool[] {
  return [
    {
      name: 'list_files',
      description: 'List files and directories inside the current code project sandbox.',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Project-relative directory. Defaults to project root.' },
          recursive: { type: 'boolean', description: 'Whether to recursively list nested files.' },
        },
        additionalProperties: false,
      },
      execute: async (args, context) => withToolError(async () => {
        const directory = stringArg(args, 'directory', '.');
        const recursive = args.recursive === true;
        const projectRoot = await codeProjectRoot(context);
        const target = directory === '.' || directory.trim() === ''
          ? projectRoot
          : await resolveCodePath(context, directory, { mustExist: true });
        const files = await listFiles(target, projectRoot, recursive);
        return completedJson({ projectId: context.projectId, directory: directory === '.' ? '/' : directory, files });
      }),
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the current code project sandbox.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative file path.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async (args, context) => withToolError(async () => {
        const path = stringArg(args, 'path');
        const filePath = await resolveCodePath(context, path, { mustExist: true });
        const content = await readFile(filePath, 'utf-8');
        return completedJson({ projectId: context.projectId, path, content });
      }),
    },
    {
      name: 'write_file',
      description: 'Write a UTF-8 text file inside the current code project sandbox.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative file path.' },
          content: { type: 'string', description: 'File content.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      execute: async (args, context) => withToolError(async () => {
        const path = stringArg(args, 'path');
        const content = stringArg(args, 'content');
        const filePath = await resolveCodePath(context, path);
        const existed = await stat(filePath).then(() => true, () => false);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, content, 'utf-8');
        const operation: CodeFileOperation = existed ? 'updated' : 'created';
        return completedJson({
          projectId: context.projectId,
          path,
          size: Buffer.byteLength(content, 'utf-8'),
          changes: [{ path, operation }],
        });
      }),
    },
    {
      name: 'grep_files',
      description: 'Search current code project text files with a JavaScript regular expression.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search string or JavaScript regular expression.' },
          directory: { type: 'string', description: 'Project-relative directory. Defaults to project root.' },
          maxResults: { type: 'number', description: 'Maximum number of matches. Defaults to 50.' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      execute: async (args, context) => withToolError(async () => {
        const pattern = stringArg(args, 'pattern');
        const directory = stringArg(args, 'directory', '.');
        const maxResults = Math.max(1, Math.min(200, numberArg(args, 'maxResults', 50)));
        const projectRoot = await codeProjectRoot(context);
        const target = directory === '.' || directory.trim() === ''
          ? projectRoot
          : await resolveCodePath(context, directory, { mustExist: true });
        const regex = new RegExp(pattern, 'i');
        const matches = await grepFiles(target, projectRoot, regex, maxResults);
        return completedJson({ projectId: context.projectId, pattern, totalMatches: matches.length, matches });
      }),
    },
    {
      name: 'list_symbols',
      description: 'List basic TypeScript/JavaScript symbols inside the current code project.',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Project-relative directory. Defaults to project root.' },
          maxResults: { type: 'number', description: 'Maximum number of symbols. Defaults to 100.' },
        },
        additionalProperties: false,
      },
      execute: async (args, context) => withToolError(async () => {
        const directory = stringArg(args, 'directory', '.');
        const maxResults = Math.max(1, Math.min(500, numberArg(args, 'maxResults', 100)));
        const projectRoot = await codeProjectRoot(context);
        const target = directory === '.' || directory.trim() === ''
          ? projectRoot
          : await resolveCodePath(context, directory, { mustExist: true });
        const symbols = await listSymbols(target, projectRoot, maxResults);
        return completedJson({ projectId: context.projectId, directory: directory === '.' ? '/' : directory, symbols });
      }),
    },
  ];
}

async function codeProjectRoot(context: ReactCoreToolContext): Promise<string> {
  if (!context.projectId) {
    throw new Error('projectId is required for code filesystem tools');
  }
  return ensureCodeProjectRoot(createCodeProjectSandbox({
    sandboxRoot: context.sandboxRoot,
    projectId: context.projectId,
  }));
}

async function resolveCodePath(
  context: ReactCoreToolContext,
  path: string,
  options?: { mustExist?: boolean }
): Promise<string> {
  if (!context.projectId) {
    throw new Error('projectId is required for code filesystem tools');
  }
  return resolveCodeProjectPath(
    createCodeProjectSandbox({
      sandboxRoot: context.sandboxRoot,
      projectId: context.projectId,
    }),
    path,
    options
  );
}

async function withToolError<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

async function listFiles(root: string, projectRoot: string, recursive: boolean): Promise<FileEntry[]> {
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
      path: normalizeRelative(projectRoot, fullPath),
      isDirectory: entry.isDirectory(),
      size: entry.isDirectory() ? undefined : itemStat.size,
    };
    result.push(item);
    if (recursive && entry.isDirectory()) {
      result.push(...await listFiles(fullPath, projectRoot, true));
    }
  }
  return result;
}

async function grepFiles(
  root: string,
  projectRoot: string,
  regex: RegExp,
  maxResults: number
): Promise<Array<{ path: string; line: number; content: string }>> {
  const matches: Array<{ path: string; line: number; content: string }> = [];
  await walk(root, async filePath => {
    if (matches.length >= maxResults || !isTextCodePath(filePath)) {
      return;
    }
    const content = await readFile(filePath, 'utf-8').catch(() => undefined);
    if (content === undefined) {
      return;
    }
    const lines = content.split('\n');
    for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
      regex.lastIndex = 0;
      if (regex.test(lines[index])) {
        matches.push({
          path: normalizeRelative(projectRoot, filePath),
          line: index + 1,
          content: lines[index].trim().slice(0, 300),
        });
      }
    }
  });
  return matches;
}

async function listSymbols(root: string, projectRoot: string, maxResults: number): Promise<CodeSymbol[]> {
  const symbols: CodeSymbol[] = [];
  await walk(root, async filePath => {
    if (symbols.length >= maxResults || !isSymbolFilePath(filePath)) {
      return;
    }
    const content = await readFile(filePath, 'utf-8').catch(() => undefined);
    if (content === undefined) {
      return;
    }
    const lines = content.split('\n');
    for (let index = 0; index < lines.length && symbols.length < maxResults; index += 1) {
      const symbol = parseSymbol(lines[index]);
      if (symbol) {
        symbols.push({
          ...symbol,
          path: normalizeRelative(projectRoot, filePath),
          line: index + 1,
        });
      }
    }
  });
  return symbols;
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

function parseSymbol(line: string): Pick<CodeSymbol, 'name' | 'kind'> | null {
  const functionMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
  if (functionMatch) {
    return { name: functionMatch[1], kind: 'function' };
  }
  const classMatch = line.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
  if (classMatch) {
    return { name: classMatch[1], kind: 'class' };
  }
  const constantMatch = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (constantMatch) {
    return { name: constantMatch[1], kind: 'constant' };
  }
  return null;
}

function shouldSkip(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === 'dist' || name.startsWith('.');
}

function isSymbolFilePath(filePath: string): boolean {
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(filePath));
}

function isTextCodePath(filePath: string): boolean {
  return isSymbolFilePath(filePath) || ['.json', '.md', '.css', '.html', '.txt'].includes(extname(filePath));
}

function normalizeRelative(root: string, value: string): string {
  return relative(root, value).split('\\').join('/');
}
