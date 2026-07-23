import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RuntimeTool } from '../runtime/tool-executor.js';
import {
  assertFileWriteContentLimit,
  FILE_WRITE_MAX_CHARACTERS,
  FILE_WRITE_MAX_ESTIMATED_TOKENS,
  fileContentArgumentLimit,
} from './filesystem-tools.js';
import { resolveWorkspaceAreaPath, resolveWorkspacePath } from './sandbox.js';
import { jsonToolOutput, runtimeContext, stringArgument } from './tool-utils.js';

const formatExtensions: Record<string, string> = {
  markdown: '.md',
  text: '.txt',
};

export function createArtifactTools(): RuntimeTool[] {
  const writeArticle = new DynamicStructuredTool({
    name: 'write_article',
    description: [
      'Write one complete prose article, report, or long-form document into workspace/artifacts.',
      `Content must not exceed ${FILE_WRITE_MAX_CHARACTERS} characters`,
      `or ${FILE_WRITE_MAX_ESTIMATED_TOKENS} estimated tokens.`,
      'Never truncate content. For a larger document, use start_file_write and append_file_chunk with an artifacts/ path.',
      'Do not use for webpages or source code; use write_file with a code/ path instead.',
    ].join(' '),
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title used to create the artifact file name.' },
        content: {
          type: 'string',
          maxLength: FILE_WRITE_MAX_CHARACTERS,
          description: `Complete document content. Maximum ${FILE_WRITE_MAX_CHARACTERS} characters.`,
        },
        format: { type: 'string', enum: ['markdown', 'text'] },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async (input, _runManager, config) => {
      const values = input as Record<string, unknown>;
      const title = stringArgument(values, 'title').trim();
      const content = stringArgument(values, 'content');
      assertFileWriteContentLimit(content);
      const format = stringArgument(values, 'format', 'markdown');
      const extension = formatExtensions[format];
      if (!title) throw new Error('Article title is required.');
      if (!extension) throw new Error(`Unsupported article format: ${format}`);
      const fileName = `${sanitizeFileName(title)}${extension}`;
      const context = runtimeContext(config);
      const filePath = await resolveWorkspaceAreaPath(
        context,
        'artifacts',
        fileName
      );
      const logicalPath = `artifacts/${fileName}`;
      const storagePath = `.revisions/${context.toolInvocationId}/${logicalPath}`;
      const revisionPath = await resolveWorkspacePath(context, storagePath);
      await mkdir(dirname(filePath), { recursive: true });
      await mkdir(dirname(revisionPath), { recursive: true });
      await writeFile(filePath, content, 'utf8');
      await writeFile(revisionPath, content, 'utf8');
      const size = Buffer.byteLength(content, 'utf8');
      const checksum = createHash('sha256').update(content).digest('hex');
      return jsonToolOutput({
        title,
        fileName,
        format,
        path: logicalPath,
        area: 'artifacts',
        size,
        artifacts: [{
          kind: 'file',
          area: 'artifacts',
          title,
          fileName,
          logicalPath,
          storagePath,
          mediaType: format === 'markdown' ? 'text/markdown' : 'text/plain',
          size,
          checksum,
          metadata: { snapshot: true },
        }],
      });
    },
  });
  return [{
    tool: writeArticle,
    sideEffectLevel: 'idempotent',
    requiresFreshContext: true,
    argumentLimits: [fileContentArgumentLimit()],
  }];
}

function sanitizeFileName(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    || 'untitled';
}
