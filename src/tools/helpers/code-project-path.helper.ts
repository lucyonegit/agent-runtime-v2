import { posix } from 'node:path';
import { RuntimeToolExecutionError } from '../../runtime/execution/tool-executor.js';

const CODE_PROJECT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const CODE_PROJECT_FILE_PATTERN = 'code/<project>/<file>';
export const CODE_PROJECT_FILE_EXAMPLE = 'code/todo-app/src/index.ts';

/**
 * code/ is a collection of projects, never a project itself. Reads remain
 * backward-compatible, while every new code write must name its project.
 */
export function assertCodeProjectFilePath(path: string): void {
  const slashPath = path.replaceAll('\\', '/');
  const canonicalInput = slashPath.replace(/^(?:\.\/)+/u, '');
  const normalized = posix.normalize(slashPath);
  const usesCodeArea = canonicalInput === 'code'
    || canonicalInput.startsWith('code/')
    || normalized === 'code'
    || normalized.startsWith('code/');
  if (!usesCodeArea) return;

  const segments = normalized.split('/');
  const project = segments[1];
  const hasFileWithinProject = segments.length >= 3 && Boolean(segments.at(-1));
  if (
    !path.includes('\\')
    && normalized === canonicalInput
    && segments[0] === 'code'
    && project !== undefined
    && CODE_PROJECT_KEY_PATTERN.test(project)
    && hasFileWithinProject
  ) return;

  throw new RuntimeToolExecutionError(
    'code_project_path_required',
    `code/ is a project collection. Use ${CODE_PROJECT_FILE_PATTERN}, for example ${CODE_PROJECT_FILE_EXAMPLE}.`,
    { path, expectedPattern: CODE_PROJECT_FILE_PATTERN },
    { executionStarted: false }
  );
}
