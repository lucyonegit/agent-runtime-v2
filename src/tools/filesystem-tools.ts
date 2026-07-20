import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RuntimeTool, RuntimeToolContext } from '../runtime/tool-executor.js';
import { resolveWorkspacePath, workspaceRoot } from './sandbox.js';
import {
  jsonToolOutput,
  numberArgument,
  runtimeContext,
  stringArgument,
} from './tool-utils.js';

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

export function createFilesystemTools(): RuntimeTool[] {
  const listFiles = new DynamicStructuredTool({
    name: 'list_files',
    description: 'List the shared Session workspace. Its standard areas are code, docs, artifacts, downloads, and tmp.',
    schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Workspace-relative directory. Defaults to root.' },
        recursive: { type: 'boolean', description: 'Recursively list nested files.' },
      },
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async (input, _runManager, config) => {
      const values = input as Record<string, unknown>;
      const context = runtimeContext(config);
      const directory = stringArgument(values, 'directory', '.');
      const root = await workspaceRoot(context);
      const target = isRootPath(directory)
        ? root
        : await resolveWorkspacePath(context, directory, { mustExist: true });
      const files = await collectFiles(target, root, values.recursive === true);
      return jsonToolOutput({
        directory: isRootPath(directory) ? '/' : directory,
        files,
      });
    },
  });

  const readFileTool = new DynamicStructuredTool({
    name: 'read_file',
    description: 'Read a UTF-8 file from the shared Session workspace, for example code/src/index.ts or docs/spec.md.',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
      required: ['path'],
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async (input, _runManager, config) => {
      const path = stringArgument(input as Record<string, unknown>, 'path');
      const context = runtimeContext(config);
      const content = await readFile(
        await resolveWorkspacePath(context, path, { mustExist: true }),
        'utf8'
      );
      return jsonToolOutput({
        path,
        content,
      });
    },
  });

  const writeFileTool = new DynamicStructuredTool({
    name: 'write_file',
    description: 'Write a UTF-8 file inside the shared Session workspace. Use code/ for webpages, applications, scripts, and source code; use docs/, artifacts/, downloads/, or tmp/ only when their category matches the requested deliverable.',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative file path. Webpages and source code must use code/, for example code/index.html.',
        },
        content: { type: 'string', description: 'Complete file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async (input, _runManager, config) => {
      const values = input as Record<string, unknown>;
      const path = stringArgument(values, 'path');
      const content = stringArgument(values, 'content');
      const context = runtimeContext(config);
      const filePath = await resolveWorkspacePath(context, path);
      const existed = await stat(filePath).then(() => true, () => false);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, 'utf8');
      const area = artifactArea(path);
      const size = Buffer.byteLength(content, 'utf8');
      const checksum = createHash('sha256').update(content).digest('hex');
      const artifacts = area ? [{
        kind: 'file' as const,
        area,
        title: basename(path),
        fileName: basename(path),
        logicalPath: path,
        storagePath: `.revisions/${context.toolInvocationId}/${path}`,
        mediaType: mediaTypeForPath(path),
        size,
        checksum,
        metadata: { operation: existed ? 'updated' : 'created' } as Record<string, unknown>,
      }] : [];
      if (artifacts.length > 0) {
        const revisionPath = await resolveWorkspacePath(
          context,
          `.revisions/${context.toolInvocationId}/${path}`
        );
        await mkdir(dirname(revisionPath), { recursive: true });
        await writeFile(revisionPath, content, 'utf8');
        artifacts[0]!.metadata = {
          ...artifacts[0]!.metadata,
          snapshot: true,
        };
      }
      return jsonToolOutput({
        path,
        size,
        operation: existed ? 'updated' : 'created',
        ...(artifacts.length > 0 ? { artifacts } : {}),
      });
    },
  });

  const grepFiles = new DynamicStructuredTool({
    name: 'grep_files',
    description: 'Search workspace text files with a JavaScript regular expression.',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search string or JavaScript regular expression.' },
        directory: { type: 'string', description: 'Workspace-relative directory. Defaults to root.' },
        maxResults: { type: 'number', description: 'Maximum matches. Defaults to 50.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async (input, _runManager, config) => {
      const values = input as Record<string, unknown>;
      const context = runtimeContext(config);
      const pattern = stringArgument(values, 'pattern');
      const directory = stringArgument(values, 'directory', '.');
      const maxResults = Math.max(1, Math.min(200, numberArgument(values, 'maxResults', 50)));
      const root = await workspaceRoot(context);
      const target = isRootPath(directory)
        ? root
        : await resolveWorkspacePath(context, directory, { mustExist: true });
      const regex = new RegExp(pattern, 'i');
      const matches = await searchFiles(target, root, regex, maxResults);
      return jsonToolOutput({ pattern, totalMatches: matches.length, matches });
    },
  });

  const listSymbols = new DynamicStructuredTool({
    name: 'list_symbols',
    description: 'List basic TypeScript and JavaScript symbols inside the current workspace.',
    schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Workspace-relative directory. Defaults to root.' },
        maxResults: { type: 'number', description: 'Maximum symbols. Defaults to 100.' },
      },
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async (input, _runManager, config) => {
      const values = input as Record<string, unknown>;
      const context = runtimeContext(config);
      const directory = stringArgument(values, 'directory', '.');
      const maxResults = Math.max(1, Math.min(500, numberArgument(values, 'maxResults', 100)));
      const root = await workspaceRoot(context);
      const target = isRootPath(directory)
        ? root
        : await resolveWorkspacePath(context, directory, { mustExist: true });
      const symbols = await collectSymbols(target, root, maxResults);
      return jsonToolOutput({ directory: isRootPath(directory) ? '/' : directory, symbols });
    },
  });

  return [
    { tool: listFiles, sideEffectLevel: 'read_only' },
    { tool: readFileTool, sideEffectLevel: 'read_only' },
    { tool: writeFileTool, sideEffectLevel: 'idempotent', requiresFreshContext: true },
    { tool: grepFiles, sideEffectLevel: 'read_only' },
    { tool: listSymbols, sideEffectLevel: 'read_only' },
  ];
}

async function collectFiles(root: string, workspace: string, recursive: boolean): Promise<FileEntry[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: FileEntry[] = [];
  for (const entry of entries) {
    if (shouldSkip(entry.name) || entry.isSymbolicLink()) continue;
    const fullPath = join(root, entry.name);
    const metadata = await stat(fullPath);
    result.push({
      name: entry.name,
      path: normalizeRelative(workspace, fullPath),
      isDirectory: entry.isDirectory(),
      ...(entry.isDirectory() ? {} : { size: metadata.size }),
    });
    if (recursive && entry.isDirectory()) {
      result.push(...await collectFiles(fullPath, workspace, true));
    }
  }
  return result;
}

async function searchFiles(
  root: string,
  workspace: string,
  regex: RegExp,
  maxResults: number
): Promise<Array<{ path: string; line: number; content: string }>> {
  const matches: Array<{ path: string; line: number; content: string }> = [];
  await walkFiles(root, async filePath => {
    if (matches.length >= maxResults || !isTextPath(filePath)) return;
    const content = await readFile(filePath, 'utf8').catch(() => undefined);
    if (content === undefined) return;
    const lines = content.split('\n');
    for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
      regex.lastIndex = 0;
      if (regex.test(lines[index]!)) {
        matches.push({
          path: normalizeRelative(workspace, filePath),
          line: index + 1,
          content: lines[index]!.trim().slice(0, 300),
        });
      }
    }
  });
  return matches;
}

async function collectSymbols(root: string, workspace: string, maxResults: number): Promise<CodeSymbol[]> {
  const symbols: CodeSymbol[] = [];
  await walkFiles(root, async filePath => {
    if (symbols.length >= maxResults || !isSymbolPath(filePath)) return;
    const content = await readFile(filePath, 'utf8').catch(() => undefined);
    if (content === undefined) return;
    for (const [index, line] of content.split('\n').entries()) {
      if (symbols.length >= maxResults) break;
      const symbol = parseSymbol(line);
      if (symbol) {
        symbols.push({ ...symbol, path: normalizeRelative(workspace, filePath), line: index + 1 });
      }
    }
  });
  return symbols;
}

async function walkFiles(root: string, visit: (filePath: string) => Promise<void>): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (shouldSkip(entry.name) || entry.isSymbolicLink()) continue;
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) await walkFiles(fullPath, visit);
    else if (entry.isFile()) await visit(fullPath);
  }
}

function parseSymbol(line: string): Pick<CodeSymbol, 'name' | 'kind'> | undefined {
  const functionMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
  if (functionMatch) return { name: functionMatch[1]!, kind: 'function' };
  const classMatch = line.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
  if (classMatch) return { name: classMatch[1]!, kind: 'class' };
  const constantMatch = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
  return constantMatch ? { name: constantMatch[1]!, kind: 'constant' } : undefined;
}

function isRootPath(path: string): boolean {
  return !path.trim() || path === '.' || path === '/';
}

function shouldSkip(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === 'dist' || name.startsWith('.');
}

function isSymbolPath(path: string): boolean {
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(path));
}

function isTextPath(path: string): boolean {
  return isSymbolPath(path) || ['.json', '.md', '.css', '.html', '.txt'].includes(extname(path));
}

function artifactArea(path: string): 'code' | 'docs' | 'artifacts' | 'downloads' | undefined {
  const area = path.replaceAll('\\', '/').split('/')[0];
  return area === 'code' || area === 'docs' || area === 'artifacts' || area === 'downloads'
    ? area
    : undefined;
}

function mediaTypeForPath(path: string): string {
  return ({
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.jsx': 'text/javascript',
    '.csv': 'text/csv',
    '.pdf': 'application/pdf',
  } as Record<string, string>)[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function normalizeRelative(root: string, value: string): string {
  return relative(root, value).split('\\').join('/');
}
