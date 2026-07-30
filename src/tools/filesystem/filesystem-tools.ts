import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { DynamicStructuredTool } from '@langchain/core/tools';
import {
  DEFAULT_TOOLS_CONFIG,
  type ToolsConfig,
} from '../../config/runtime-config.js';
import {
  RuntimeToolExecutionError,
  type RuntimeTool,
  type RuntimeToolContext,
} from '../../runtime/execution/tool-executor.js';
import { estimateTextTokens } from '../../runtime/context/helpers/token-budget.helper.js';
import {
  resolveWorkspacePath,
  workspaceRoot,
} from '../helpers/workspace-path.helper.js';
import {
  assertCodeProjectFilePath,
  CODE_PROJECT_FILE_EXAMPLE,
} from '../helpers/code-project-path.helper.js';
import {
  jsonToolOutput,
  numberArgument,
  runtimeContext,
  stringArgument,
} from '../helpers/tool-input.helper.js';

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

const FILESYSTEM_TOOL_LIMITS = {
  maximumReadBytes: 1_048_576,
  maximumListEntries: 10_000,
  maximumTraversalDepth: 50,
  grepDefaultResults: 50,
  grepMaximumResults: 200,
  symbolsDefaultResults: 100,
  symbolsMaximumResults: 500,
  linePreviewCharacters: 300,
} as const;

type FilesystemToolConfig =
  ToolsConfig['filesystem'] & typeof FILESYSTEM_TOOL_LIMITS;

export const FILE_WRITE_MAX_CHARACTERS =
  DEFAULT_TOOLS_CONFIG.filesystem.maximumWriteCharacters;
export const FILE_WRITE_MAX_ESTIMATED_TOKENS =
  DEFAULT_TOOLS_CONFIG.filesystem.maximumWriteEstimatedTokens;

export const FILE_WRITE_LIMIT_MESSAGE = [
  `File content exceeds the single-call limit of ${FILE_WRITE_MAX_CHARACTERS} characters`,
  `or ${FILE_WRITE_MAX_ESTIMATED_TOKENS} estimated tokens.`,
  'Split code into smaller files, or use start_file_write followed by append_file_chunk.',
].join(' ');

interface FileWriteChunk {
  index: number;
  size: number;
  checksum: string;
}

interface OpenFileWriteManifest {
  schemaVersion: 1;
  status: 'open';
  writeId: string;
  sessionId: string;
  path: string;
  targetExisted: boolean;
  nextChunkIndex: number;
  chunks: FileWriteChunk[];
}

interface CompletedFileWriteManifest {
  schemaVersion: 1;
  status: 'completed';
  writeId: string;
  sessionId: string;
  path: string;
  targetExisted: boolean;
  nextChunkIndex: number;
  chunks: FileWriteChunk[];
  finalizationToolCallId: string;
  result: CompletedFileWriteResult;
  artifact: ReturnType<typeof createFileArtifactDraft> | undefined;
}

type FileWriteManifest = OpenFileWriteManifest | CompletedFileWriteManifest;

interface CompletedFileWriteResult {
  writeId: string;
  path: string;
  acceptedChunkIndex: number;
  status: 'completed';
  size: number;
  checksum: string;
  operation: 'created' | 'updated';
}

const fileWriteLocks = new Map<string, Promise<void>>();

export function createFilesystemTools(
  filesystemOptions: ToolsConfig['filesystem'] =
    DEFAULT_TOOLS_CONFIG.filesystem
): RuntimeTool[] {
  const filesystemConfig: FilesystemToolConfig = {
    ...filesystemOptions,
    ...FILESYSTEM_TOOL_LIMITS,
  };
  const listFiles = new DynamicStructuredTool({
    name: 'list_files',
    description: 'List the shared Session workspace. Its standard areas are code, docs, artifacts, downloads, and tmp. code/ is a collection whose immediate children are separate project directories.',
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
      const files = await collectFiles(
        target,
        root,
        values.recursive === true,
        filesystemConfig
      );
      return jsonToolOutput({
        directory: isRootPath(directory) ? '/' : directory,
        files,
      });
    },
  });

  const readFileTool = new DynamicStructuredTool({
    name: 'read_file',
    description: `Read a UTF-8 file from the shared Session workspace, for example ${CODE_PROJECT_FILE_EXAMPLE} or docs/spec.md.`,
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
      const filePath = await resolveWorkspacePath(context, path, { mustExist: true });
      const metadata = await stat(filePath);
      if (metadata.size > filesystemConfig.maximumReadBytes) {
        throw new RuntimeToolExecutionError(
          'file_read_limit_exceeded',
          `File exceeds the configured ${filesystemConfig.maximumReadBytes} byte read limit.`,
          { path, size: metadata.size }
        );
      }
      const content = await readFile(filePath, 'utf8');
      return jsonToolOutput({
        path,
        content,
      });
    },
  });

  const writeFileTool = new DynamicStructuredTool({
    name: 'write_file',
    description: [
      'Write one complete UTF-8 file inside the shared Session workspace.',
      `The complete content must not exceed ${filesystemConfig.maximumWriteCharacters} characters`,
      `or ${filesystemConfig.maximumWriteEstimatedTokens} estimated tokens.`,
      'Prefer splitting large implementations into smaller modules/files.',
      'Never truncate content. For one indivisible large file, use start_file_write and append_file_chunk.',
      'Use code/<project>/ for webpages, applications, scripts, and source code. code/ is only a collection root, so never write a project file directly under it.',
      'Use docs/, artifacts/, downloads/, or tmp/ only when their category matches the requested deliverable.',
    ].join(' '),
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: `Workspace-relative file path. Webpages and source code must name a project, for example ${CODE_PROJECT_FILE_EXAMPLE}.`,
        },
        content: {
          type: 'string',
          maxLength: filesystemConfig.maximumWriteCharacters,
          description: `Complete file content. Maximum ${filesystemConfig.maximumWriteCharacters} characters; never truncate.`,
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async (input, _runManager, config) => {
      const values = input as Record<string, unknown>;
      const path = stringArgument(values, 'path');
      const content = stringArgument(values, 'content');
      assertCodeProjectFilePath(path);
      assertFileWriteContentLimit(content, filesystemConfig);
      const context = runtimeContext(config);
      const filePath = await resolveWorkspacePath(context, path);
      const existed = await stat(filePath).then(() => true, () => false);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, 'utf8');
      const artifact = createFileArtifactDraft({
        context,
        path,
        content,
        operation: existed ? 'updated' : 'created',
      });
      const artifacts = artifact ? [artifact] : [];
      if (artifacts.length > 0) {
        const revisionPath = await resolveWorkspacePath(
          context,
          `.revisions/${context.toolCallId}/${path}`
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
        size: Buffer.byteLength(content, 'utf8'),
        operation: existed ? 'updated' : 'created',
        ...(artifacts.length > 0 ? { artifacts } : {}),
      });
    },
  });

  const startFileWrite = new DynamicStructuredTool({
    name: 'start_file_write',
    description: [
      'Start an atomic, chunked write for one UTF-8 file that cannot fit in write_file.',
      `Provide the first chunk only, limited to ${filesystemConfig.maximumWriteCharacters} characters`,
      `or ${filesystemConfig.maximumWriteEstimatedTokens} estimated tokens.`,
      'The destination file is not changed and no Artifact is created until append_file_chunk is called with finalize=true.',
      `A code destination must name its project, for example ${CODE_PROJECT_FILE_EXAMPLE}.`,
      'Call this tool alone, wait for its ToolMessage, then use the returned writeId.',
    ].join(' '),
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: `Workspace-relative destination file path. A code path must follow code/<project>/<file>, for example ${CODE_PROJECT_FILE_EXAMPLE}.`,
        },
        content: {
          type: 'string',
          maxLength: filesystemConfig.maximumWriteCharacters,
          description: `First file chunk. Maximum ${filesystemConfig.maximumWriteCharacters} characters.`,
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async (input, _runManager, config) => {
      const values = input as Record<string, unknown>;
      const path = stringArgument(values, 'path');
      const content = stringArgument(values, 'content');
      assertCodeProjectFilePath(path);
      assertFileWriteContentLimit(content, filesystemConfig);
      const context = runtimeContext(config);
      const writeId = createFileWriteId(context.idempotencyKey);
      return jsonToolOutput(await withFileWriteLock(writeId, async () => (
        startChunkedFileWrite({ context, writeId, path, content })
      )));
    },
  });

  const appendFileChunk = new DynamicStructuredTool({
    name: 'append_file_chunk',
    description: [
      'Append exactly one sequential chunk to a file write created by start_file_write.',
      `Each chunk is limited to ${filesystemConfig.maximumWriteCharacters} characters`,
      `or ${filesystemConfig.maximumWriteEstimatedTokens} estimated tokens.`,
      'Use the exact nextChunkIndex returned by the previous ToolMessage.',
      'Set finalize=true only on the last chunk. Finalization atomically replaces the destination and creates one Artifact.',
      'Call this tool alone and wait for its ToolMessage before sending another chunk.',
    ].join(' '),
    schema: {
      type: 'object',
      properties: {
        writeId: {
          type: 'string',
          pattern: '^file_write_[a-f0-9]{32}$',
          description: 'Stable write ID returned by start_file_write.',
        },
        chunkIndex: {
          type: 'integer',
          minimum: 1,
          description: 'Exact nextChunkIndex returned by the previous chunk result.',
        },
        content: {
          type: 'string',
          maxLength: filesystemConfig.maximumWriteCharacters,
          description: `Next file chunk. Maximum ${filesystemConfig.maximumWriteCharacters} characters.`,
        },
        finalize: {
          type: 'boolean',
          description: 'Set true only for the final chunk.',
        },
      },
      required: ['writeId', 'chunkIndex', 'content', 'finalize'],
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async (input, _runManager, config) => {
      const values = input as Record<string, unknown>;
      const writeId = stringArgument(values, 'writeId');
      const chunkIndex = numberArgument(values, 'chunkIndex', -1);
      const content = stringArgument(values, 'content');
      const finalize = values.finalize === true;
      assertFileWriteId(writeId);
      assertFileWriteContentLimit(content, filesystemConfig);
      if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 1) {
        throw new RuntimeToolExecutionError(
          'file_chunk_index_invalid',
          'chunkIndex must be a positive integer starting at 1.'
        );
      }
      const context = runtimeContext(config);
      return jsonToolOutput(await withFileWriteLock(writeId, async () => (
        appendChunkedFileWrite({
          context,
          writeId,
          chunkIndex,
          content,
          finalize,
        })
      )));
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
        maxResults: {
          type: 'number',
          description: `Maximum matches. Defaults to ${filesystemConfig.grepDefaultResults}.`,
        },
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
      const maxResults = Math.max(1, Math.min(
        filesystemConfig.grepMaximumResults,
        numberArgument(values, 'maxResults', filesystemConfig.grepDefaultResults)
      ));
      const root = await workspaceRoot(context);
      const target = isRootPath(directory)
        ? root
        : await resolveWorkspacePath(context, directory, { mustExist: true });
      const regex = new RegExp(pattern, 'i');
      const matches = await searchFiles(
        target,
        root,
        regex,
        maxResults,
        filesystemConfig
      );
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
        maxResults: {
          type: 'number',
          description: `Maximum symbols. Defaults to ${filesystemConfig.symbolsDefaultResults}.`,
        },
      },
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async (input, _runManager, config) => {
      const values = input as Record<string, unknown>;
      const context = runtimeContext(config);
      const directory = stringArgument(values, 'directory', '.');
      const maxResults = Math.max(1, Math.min(
        filesystemConfig.symbolsMaximumResults,
        numberArgument(values, 'maxResults', filesystemConfig.symbolsDefaultResults)
      ));
      const root = await workspaceRoot(context);
      const target = isRootPath(directory)
        ? root
        : await resolveWorkspacePath(context, directory, { mustExist: true });
      const symbols = await collectSymbols(
        target,
        root,
        maxResults,
        filesystemConfig
      );
      return jsonToolOutput({ directory: isRootPath(directory) ? '/' : directory, symbols });
    },
  });

  return [
    { tool: listFiles, sideEffectLevel: 'read_only' },
    { tool: readFileTool, sideEffectLevel: 'read_only' },
    {
      tool: writeFileTool,
      sideEffectLevel: 'idempotent',
      requiresFreshContext: true,
      argumentLimits: [fileContentArgumentLimit(filesystemConfig)],
    },
    {
      tool: startFileWrite,
      sideEffectLevel: 'idempotent',
      exclusive: true,
      requiresFreshContext: true,
      argumentLimits: [fileContentArgumentLimit(filesystemConfig)],
    },
    {
      tool: appendFileChunk,
      sideEffectLevel: 'idempotent',
      exclusive: true,
      requiresFreshContext: true,
      argumentLimits: [fileContentArgumentLimit(filesystemConfig)],
    },
    { tool: grepFiles, sideEffectLevel: 'read_only' },
    { tool: listSymbols, sideEffectLevel: 'read_only' },
  ];
}

export function fileContentArgumentLimit(
  config: ToolsConfig['filesystem'] = DEFAULT_TOOLS_CONFIG.filesystem
) {
  return {
    path: 'content',
    maxCharacters: config.maximumWriteCharacters,
    maxEstimatedTokens: config.maximumWriteEstimatedTokens,
    errorCode: 'file_content_too_large',
    message: fileWriteLimitMessage(config),
  };
}

export function assertFileWriteContentLimit(
  content: string,
  config: ToolsConfig['filesystem'] = DEFAULT_TOOLS_CONFIG.filesystem
): void {
  const estimatedTokens = estimateTextTokens(content);
  if (
    content.length <= config.maximumWriteCharacters
    && estimatedTokens <= config.maximumWriteEstimatedTokens
  ) return;
  throw new RuntimeToolExecutionError(
    'file_content_too_large',
    fileWriteLimitMessage(config),
    {
      characters: content.length,
      estimatedTokens,
      maxCharacters: config.maximumWriteCharacters,
      maxEstimatedTokens: config.maximumWriteEstimatedTokens,
    }
  );
}

function fileWriteLimitMessage(config: ToolsConfig['filesystem']): string {
  return [
    `File content exceeds the single-call limit of ${config.maximumWriteCharacters} characters`,
    `or ${config.maximumWriteEstimatedTokens} estimated tokens.`,
    'Split code into smaller files, or use start_file_write followed by append_file_chunk.',
  ].join(' ');
}

function createFileWriteId(idempotencyKey: string): string {
  return `file_write_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
}

async function startChunkedFileWrite(input: {
  context: RuntimeToolContext;
  writeId: string;
  path: string;
  content: string;
}): Promise<Record<string, unknown>> {
  const directory = await fileWriteDirectory(input.context, input.writeId);
  const manifestPath = join(directory, 'manifest.json');
  const existingManifest = await readFileWriteManifest(manifestPath);
  const chunk = fileWriteChunk(0, input.content);
  if (existingManifest) {
    const existingFirstChunk = existingManifest.chunks[0];
    if (
      existingManifest.path !== input.path
      || existingFirstChunk?.checksum !== chunk.checksum
    ) {
      throw new RuntimeToolExecutionError(
        'file_write_conflict',
        `Chunked file write ${input.writeId} already exists with different content.`
      );
    }
    return openFileWriteResult(existingManifest, 0);
  }

  const targetPath = await resolveWorkspacePath(input.context, input.path);
  const targetExisted = await stat(targetPath).then(() => true, () => false);
  await mkdir(directory, { recursive: true });
  await writeChunkPart(directory, chunk, input.content);
  const manifest: OpenFileWriteManifest = {
    schemaVersion: 1,
    status: 'open',
    writeId: input.writeId,
    sessionId: input.context.sessionId,
    path: input.path,
    targetExisted,
    nextChunkIndex: 1,
    chunks: [chunk],
  };
  await writeFileWriteManifest(manifestPath, manifest, input.context.toolCallId);
  return openFileWriteResult(manifest, 0);
}

async function appendChunkedFileWrite(input: {
  context: RuntimeToolContext;
  writeId: string;
  chunkIndex: number;
  content: string;
  finalize: boolean;
}): Promise<Record<string, unknown>> {
  const directory = await fileWriteDirectory(input.context, input.writeId);
  const manifestPath = join(directory, 'manifest.json');
  const manifest = await readFileWriteManifest(manifestPath);
  if (!manifest) {
    throw new RuntimeToolExecutionError(
      'file_write_not_found',
      `Chunked file write ${input.writeId} was not found in this Session workspace.`
    );
  }
  if (manifest.sessionId !== input.context.sessionId) {
    throw new RuntimeToolExecutionError(
      'file_write_session_mismatch',
      `Chunked file write ${input.writeId} belongs to another Session.`
    );
  }
  assertCodeProjectFilePath(manifest.path);
  const chunk = fileWriteChunk(input.chunkIndex, input.content);
  if (manifest.status === 'completed') {
    const existing = manifest.chunks.find(candidate => candidate.index === input.chunkIndex);
    if (
      !input.finalize
      || !existing
      || existing.checksum !== chunk.checksum
      || input.chunkIndex !== manifest.result.acceptedChunkIndex
    ) {
      throw new RuntimeToolExecutionError(
        'file_write_already_completed',
        `Chunked file write ${input.writeId} is already completed.`
      );
    }
    return {
      ...manifest.result,
      replayed: true,
      ...(manifest.finalizationToolCallId === input.context.toolCallId
        && manifest.artifact
        ? { artifacts: [manifest.artifact] }
        : {}),
    };
  }

  if (input.chunkIndex > manifest.nextChunkIndex) {
    throw new RuntimeToolExecutionError(
      'file_chunk_out_of_order',
      `Expected chunkIndex ${manifest.nextChunkIndex}, received ${input.chunkIndex}.`,
      { expectedChunkIndex: manifest.nextChunkIndex, receivedChunkIndex: input.chunkIndex }
    );
  }
  if (input.chunkIndex < manifest.nextChunkIndex) {
    const existing = manifest.chunks.find(candidate => candidate.index === input.chunkIndex);
    if (!existing || existing.checksum !== chunk.checksum) {
      throw new RuntimeToolExecutionError(
        'file_chunk_conflict',
        `Chunk ${input.chunkIndex} was already accepted with different content.`
      );
    }
    if (input.finalize) {
      throw new RuntimeToolExecutionError(
        'file_chunk_already_accepted',
        `Chunk ${input.chunkIndex} was already accepted without finalization. Continue at chunkIndex ${manifest.nextChunkIndex}.`
      );
    }
    return openFileWriteResult(manifest, input.chunkIndex, true);
  }

  await writeChunkPart(directory, chunk, input.content);
  const chunks = [...manifest.chunks, chunk];
  if (!input.finalize) {
    const updated: OpenFileWriteManifest = {
      ...manifest,
      nextChunkIndex: input.chunkIndex + 1,
      chunks,
    };
    await writeFileWriteManifest(manifestPath, updated, input.context.toolCallId);
    return openFileWriteResult(updated, input.chunkIndex);
  }

  const completed = await finalizeChunkedFileWrite({
    context: input.context,
    manifest: { ...manifest, chunks },
    directory,
    acceptedChunkIndex: input.chunkIndex,
  });
  await writeFileWriteManifest(manifestPath, completed, input.context.toolCallId);
  return {
    ...completed.result,
    ...(completed.artifact ? { artifacts: [completed.artifact] } : {}),
  };
}

async function finalizeChunkedFileWrite(input: {
  context: RuntimeToolContext;
  manifest: OpenFileWriteManifest;
  directory: string;
  acceptedChunkIndex: number;
}): Promise<CompletedFileWriteManifest> {
  for (let index = 0; index <= input.acceptedChunkIndex; index += 1) {
    if (input.manifest.chunks[index]?.index !== index) {
      throw new RuntimeToolExecutionError(
        'file_chunk_missing',
        `Cannot finalize because chunk ${index} is missing.`
      );
    }
  }
  const content = Buffer.concat(await Promise.all(
    input.manifest.chunks.map(chunk => readFile(chunkPartPath(input.directory, chunk.index)))
  ));
  const checksum = createHash('sha256').update(content).digest('hex');
  const targetPath = await resolveWorkspacePath(input.context, input.manifest.path);
  await mkdir(dirname(targetPath), { recursive: true });
  const targetTemporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${input.manifest.writeId}.tmp`
  );
  await writeFile(targetTemporaryPath, content);
  await rename(targetTemporaryPath, targetPath);

  const operation = input.manifest.targetExisted ? 'updated' : 'created';
  const artifact = createFileArtifactDraft({
    context: input.context,
    path: input.manifest.path,
    content,
    operation,
    metadata: {
      chunked: true,
      chunkCount: input.manifest.chunks.length,
      writeId: input.manifest.writeId,
    },
  });
  if (artifact) {
    const revisionPath = await resolveWorkspacePath(input.context, artifact.storagePath);
    await mkdir(dirname(revisionPath), { recursive: true });
    await writeFile(revisionPath, content);
  }
  return {
    ...input.manifest,
    status: 'completed',
    nextChunkIndex: input.acceptedChunkIndex + 1,
    finalizationToolCallId: input.context.toolCallId,
    result: {
      writeId: input.manifest.writeId,
      path: input.manifest.path,
      acceptedChunkIndex: input.acceptedChunkIndex,
      status: 'completed',
      size: content.byteLength,
      checksum,
      operation,
    },
    artifact,
  };
}

function createFileArtifactDraft(input: {
  context: RuntimeToolContext;
  path: string;
  content: string | Buffer;
  operation: 'created' | 'updated';
  metadata?: Record<string, unknown>;
}) {
  const area = artifactArea(input.path);
  if (!area) return undefined;
  return {
    kind: 'file' as const,
    area,
    title: basename(input.path),
    fileName: basename(input.path),
    logicalPath: input.path,
    storagePath: `.revisions/${input.context.toolCallId}/${input.path}`,
    mediaType: mediaTypeForPath(input.path),
    size: Buffer.byteLength(input.content),
    checksum: createHash('sha256').update(input.content).digest('hex'),
    metadata: {
      operation: input.operation,
      snapshot: true,
      ...input.metadata,
    } as Record<string, unknown>,
  };
}

function fileWriteChunk(index: number, content: string): FileWriteChunk {
  return {
    index,
    size: Buffer.byteLength(content, 'utf8'),
    checksum: createHash('sha256').update(content).digest('hex'),
  };
}

function openFileWriteResult(
  manifest: FileWriteManifest,
  acceptedChunkIndex: number,
  replayed = false
): Record<string, unknown> {
  if (manifest.status === 'completed') return { ...manifest.result, replayed };
  return {
    writeId: manifest.writeId,
    path: manifest.path,
    acceptedChunkIndex,
    nextChunkIndex: manifest.nextChunkIndex,
    bufferedBytes: manifest.chunks.reduce((total, chunk) => total + chunk.size, 0),
    status: 'open',
    ...(replayed ? { replayed: true } : {}),
  };
}

async function fileWriteDirectory(
  context: RuntimeToolContext,
  writeId: string
): Promise<string> {
  assertFileWriteId(writeId);
  return resolveWorkspacePath(context, `.runtime/file-writes/${writeId}`);
}

function chunkPartPath(directory: string, index: number): string {
  return join(directory, `${String(index).padStart(6, '0')}.part`);
}

async function writeChunkPart(
  directory: string,
  chunk: FileWriteChunk,
  content: string
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const path = chunkPartPath(directory, chunk.index);
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
    const existing = await readFile(path);
    const checksum = createHash('sha256').update(existing).digest('hex');
    if (checksum !== chunk.checksum) {
      throw new RuntimeToolExecutionError(
        'file_chunk_conflict',
        `Chunk ${chunk.index} already exists with different content.`
      );
    }
  }
}

async function readFileWriteManifest(path: string): Promise<FileWriteManifest | undefined> {
  const content = await readFile(path, 'utf8').catch(error => {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  });
  if (content === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new RuntimeToolExecutionError(
      'file_write_state_invalid',
      `Chunked file write state is invalid: ${path}`
    );
  }
  if (!isFileWriteManifest(value)) {
    throw new RuntimeToolExecutionError(
      'file_write_state_invalid',
      `Chunked file write state has an unsupported structure: ${path}`
    );
  }
  return value;
}

async function writeFileWriteManifest(
  path: string,
  manifest: FileWriteManifest,
  toolCallId: string
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${toolCallId}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(manifest), 'utf8');
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function isFileWriteManifest(value: unknown): value is FileWriteManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Partial<FileWriteManifest>;
  const commonIsValid = manifest.schemaVersion === 1
    && (manifest.status === 'open' || manifest.status === 'completed')
    && typeof manifest.writeId === 'string'
    && typeof manifest.sessionId === 'string'
    && typeof manifest.path === 'string'
    && typeof manifest.targetExisted === 'boolean'
    && Number.isSafeInteger(manifest.nextChunkIndex)
    && Array.isArray(manifest.chunks)
    && manifest.chunks.every(chunk => (
      chunk
      && Number.isSafeInteger(chunk.index)
      && typeof chunk.size === 'number'
      && typeof chunk.checksum === 'string'
    ));
  if (!commonIsValid) return false;
  if (manifest.status === 'open') return true;
  const completed = manifest as Partial<CompletedFileWriteManifest>;
  return typeof completed.finalizationToolCallId === 'string'
    && isCompletedFileWriteResult(completed.result);
}

function isCompletedFileWriteResult(value: unknown): value is CompletedFileWriteResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Partial<CompletedFileWriteResult>;
  return typeof result.writeId === 'string'
    && typeof result.path === 'string'
    && Number.isSafeInteger(result.acceptedChunkIndex)
    && result.status === 'completed'
    && typeof result.size === 'number'
    && Number.isSafeInteger(result.size)
    && typeof result.checksum === 'string'
    && (result.operation === 'created' || result.operation === 'updated');
}

function assertFileWriteId(writeId: string): void {
  if (/^file_write_[a-f0-9]{32}$/.test(writeId)) return;
  throw new RuntimeToolExecutionError(
    'file_write_id_invalid',
    'writeId must be the value returned by start_file_write.'
  );
}

async function withFileWriteLock<T>(
  writeId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = fileWriteLocks.get(writeId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  fileWriteLocks.set(writeId, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (fileWriteLocks.get(writeId) === queued) fileWriteLocks.delete(writeId);
  }
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'EEXIST');
}

function isFileNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
}

async function collectFiles(
  root: string,
  workspace: string,
  recursive: boolean,
  config: FilesystemToolConfig
): Promise<FileEntry[]> {
  const result: FileEntry[] = [];
  const collect = async (directory: string, depth: number): Promise<void> => {
    if (depth > config.maximumTraversalDepth) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (result.length >= config.maximumListEntries) return;
      if (shouldSkip(entry.name) || entry.isSymbolicLink()) continue;
      const fullPath = join(directory, entry.name);
      const metadata = await stat(fullPath);
      result.push({
        name: entry.name,
        path: normalizeRelative(workspace, fullPath),
        isDirectory: entry.isDirectory(),
        ...(entry.isDirectory() ? {} : { size: metadata.size }),
      });
      if (recursive && entry.isDirectory()) await collect(fullPath, depth + 1);
    }
  };
  await collect(root, 0);
  return result;
}

async function searchFiles(
  root: string,
  workspace: string,
  regex: RegExp,
  maxResults: number,
  config: FilesystemToolConfig
): Promise<Array<{ path: string; line: number; content: string }>> {
  const matches: Array<{ path: string; line: number; content: string }> = [];
  await walkFiles(root, config.maximumTraversalDepth, async filePath => {
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
          content: lines[index]!.trim().slice(0, config.linePreviewCharacters),
        });
      }
    }
  });
  return matches;
}

async function collectSymbols(
  root: string,
  workspace: string,
  maxResults: number,
  config: FilesystemToolConfig
): Promise<CodeSymbol[]> {
  const symbols: CodeSymbol[] = [];
  await walkFiles(root, config.maximumTraversalDepth, async filePath => {
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

async function walkFiles(
  root: string,
  maximumDepth: number,
  visit: (filePath: string) => Promise<void>,
  depth = 0
): Promise<void> {
  if (depth > maximumDepth) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (shouldSkip(entry.name) || entry.isSymbolicLink()) continue;
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) await walkFiles(fullPath, maximumDepth, visit, depth + 1);
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
