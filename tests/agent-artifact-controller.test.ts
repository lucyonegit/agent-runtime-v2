import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentArtifact } from '../src/domain/artifact.js';
import type { AgentRuntime } from '../src/orchestration/agent-runtime.js';
import {
  AgentArtifactController,
  MAX_ARTIFACT_PREVIEW_BYTES,
} from '../src/server/http/agent-artifact.controller.js';

describe('AgentArtifactController', () => {
  let sandboxRoot: string;

  beforeEach(async () => {
    sandboxRoot = await mkdtemp(join(tmpdir(), 'agent-artifact-preview-'));
  });

  afterEach(async () => {
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it('streams the immutable artifact snapshot with safe preview headers', async () => {
    const artifact = artifactFixture();
    const snapshotPath = join(
      sandboxRoot,
      'sessions',
      artifact.sessionId,
      'workspace',
      artifact.storagePath
    );
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, 'const answer = 42;');
    const controller = new AgentArtifactController(runtimeWith([artifact]), sandboxRoot);

    const response = await controller.getArtifactContent(artifact.sessionId, artifact.id);

    expect(response.getHeaders()).toMatchObject({
      type: 'text/javascript',
      length: 18,
    });
    expect(await streamText(response.getStream())).toBe('const answer = 42;');
  });

  it('only resolves artifacts projected by the requested Session', async () => {
    const controller = new AgentArtifactController(runtimeWith([]), sandboxRoot);

    await expect(controller.getArtifactContent('session_1', 'artifact_other'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects storage paths that escape the Session workspace', async () => {
    const controller = new AgentArtifactController(runtimeWith([
      artifactFixture({ storagePath: '../../outside.txt' }),
    ]), sandboxRoot);

    await expect(controller.getArtifactContent('session_1', 'artifact_1'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects previews larger than the bounded response limit', async () => {
    const controller = new AgentArtifactController(runtimeWith([
      artifactFixture({ size: MAX_ARTIFACT_PREVIEW_BYTES + 1 }),
    ]), sandboxRoot);

    await expect(controller.getArtifactContent('session_1', 'artifact_1'))
      .rejects.toBeInstanceOf(PayloadTooLargeException);
  });
});

function runtimeWith(artifacts: AgentArtifact[]): AgentRuntime {
  return {
    getSessionView: vi.fn(async () => ({ artifacts })),
  } as unknown as AgentRuntime;
}

function artifactFixture(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    id: 'artifact_1',
    sessionId: 'session_1',
    taskId: 'task_1',
    toolCallId: 'tool_1',
    resultMessageId: 'result_1',
    kind: 'file',
    area: 'code',
    title: 'app.js',
    fileName: 'app.js',
    logicalPath: 'code/app.js',
    storagePath: '.revisions/tool_1/code/app.js',
    mediaType: 'text/javascript',
    size: 18,
    checksum: 'checksum',
    revision: 1,
    createdAtMs: 1,
    ...overrides,
  };
}

async function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
