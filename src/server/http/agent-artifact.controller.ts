import { readFile, stat } from 'node:fs/promises';
import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  StreamableFile,
} from '@nestjs/common';
import { AgentRuntime } from '../../orchestration/agent-runtime.js';
import { resolveExistingWorkspacePath } from '../../tools/helpers/workspace-path.helper.js';

export const RUNTIME_ARTIFACT_SANDBOX_ROOT = Symbol('RUNTIME_ARTIFACT_SANDBOX_ROOT');
export const MAX_ARTIFACT_PREVIEW_BYTES = 5 * 1024 * 1024;

@Controller()
export class AgentArtifactController {
  constructor(
    private readonly runtime: AgentRuntime,
    @Inject(RUNTIME_ARTIFACT_SANDBOX_ROOT)
    private readonly sandboxRoot: string
  ) {}

  @Get('sessions/:sessionId/artifacts/:artifactId/content')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async getArtifactContent(
    @Param('sessionId') sessionId: string,
    @Param('artifactId') artifactId: string
  ): Promise<StreamableFile> {
    const view = await this.runtime.getSessionView(sessionId);
    const artifact = view.artifacts.find(candidate => candidate.id === artifactId);
    if (!artifact) throw new NotFoundException('Artifact was not found in this Session.');
    if (artifact.size > MAX_ARTIFACT_PREVIEW_BYTES) throw previewTooLarge();

    let filePath: string;
    let fileSize: number;
    try {
      filePath = await resolveExistingWorkspacePath(
        { sandboxRoot: this.sandboxRoot, sessionId },
        artifact.storagePath
      );
      const file = await stat(filePath);
      if (!file.isFile()) throw new Error('Artifact snapshot is not a file.');
      fileSize = file.size;
    } catch {
      throw new NotFoundException('Artifact snapshot is unavailable.');
    }

    if (fileSize > MAX_ARTIFACT_PREVIEW_BYTES) throw previewTooLarge();
    try {
      const content = await readFile(filePath);
      return new StreamableFile(content, {
        type: safeMediaType(artifact.mediaType),
        disposition: `inline; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`,
        length: content.byteLength,
      });
    } catch {
      throw new NotFoundException('Artifact snapshot is unavailable.');
    }
  }
}

function safeMediaType(value: string): string {
  const baseType = value.split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(baseType)
    ? baseType
    : 'application/octet-stream';
}

function previewTooLarge(): PayloadTooLargeException {
  return new PayloadTooLargeException(
    `Artifact preview is limited to ${MAX_ARTIFACT_PREVIEW_BYTES} bytes.`
  );
}
