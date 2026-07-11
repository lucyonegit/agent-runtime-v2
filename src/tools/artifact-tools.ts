import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RuntimeTool } from '../runtime/tool-executor.js';
import { resolveWorkspaceAreaPath } from './sandbox.js';
import { jsonToolOutput, runtimeContext, stringArgument } from './tool-utils.js';

const formatExtensions: Record<string, string> = {
  markdown: '.md',
  text: '.txt',
};

export function createArtifactTools(): RuntimeTool[] {
  const writeArticle = new DynamicStructuredTool({
    name: 'write_article',
    description: 'Write a prose article, report, or long-form document into workspace/artifacts. Do not use for webpages or source code; use write_file with a code/ path instead.',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title used to create the artifact file name.' },
        content: { type: 'string', description: 'Document content.' },
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
      const format = stringArgument(values, 'format', 'markdown');
      const extension = formatExtensions[format];
      if (!title) throw new Error('Article title is required.');
      if (!extension) throw new Error(`Unsupported article format: ${format}`);
      const fileName = `${sanitizeFileName(title)}${extension}`;
      const filePath = await resolveWorkspaceAreaPath(
        runtimeContext(config),
        'artifacts',
        fileName
      );
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, 'utf8');
      return jsonToolOutput({
        title,
        fileName,
        format,
        path: filePath,
        area: 'artifacts',
        size: Buffer.byteLength(content, 'utf8'),
      });
    },
  });
  return [{ tool: writeArticle, sideEffectLevel: 'idempotent' }];
}

function sanitizeFileName(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    || 'untitled';
}
