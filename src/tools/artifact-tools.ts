import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RuntimeTool } from './types.js';
import { completedJson, failed, stringArg } from './types.js';
import { createSandbox, resolveSandboxPath } from './sandbox.js';

const formatExtensions: Record<string, string> = {
  markdown: '.md',
  text: '.txt',
  html: '.html',
};

export function createArtifactTools(): RuntimeTool[] {
  return [
    {
      name: 'write_article',
      description: 'Write an article, report, document, or long-form text into the session artifacts sandbox.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Document title. It will be sanitized into the artifact file name.',
          },
          content: {
            type: 'string',
            description: 'Document content. Markdown is supported when format is markdown.',
          },
          format: {
            type: 'string',
            enum: ['markdown', 'text', 'html'],
            description: 'Artifact file format.',
          },
        },
        required: ['title', 'content'],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const title = stringArg(args, 'title');
        const content = stringArg(args, 'content');
        const format = stringArg(args, 'format', 'markdown');
        const ext = formatExtensions[format];
        if (!title.trim()) {
          return failed('Article title is required.');
        }
        if (!ext) {
          return failed(`Unsupported article format: ${format}`);
        }

        try {
          const sandbox = createSandbox({ root: context.sandboxRoot, sessionId: context.sessionId });
          const fileName = `${sanitizeFileName(title)}${ext}`;
          const filePath = await resolveSandboxPath(sandbox, 'artifacts', fileName);
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, content, 'utf-8');
          return completedJson({
            title,
            fileName,
            format,
            path: filePath,
            area: 'artifacts',
            size: Buffer.byteLength(content, 'utf-8'),
          });
        } catch (error) {
          return failed(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
}

function sanitizeFileName(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    || 'untitled';
}
