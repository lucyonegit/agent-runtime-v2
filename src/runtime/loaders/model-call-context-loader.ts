import { createHash } from 'node:crypto';
import type { AgentModelCall } from '../../domain/index.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { compileContext, type BuiltContext } from '../context/context-compiler.js';
import type { ContextMaterial } from '../context/context-material.js';

export type ModelCallContextStore = Pick<AgentStore, 'getModelCall'>;

export class ContextSnapshotUnreconstructableError extends Error {
  readonly code = 'context_snapshot_unreconstructable';

  constructor(message: string) {
    super(message);
    this.name = 'ContextSnapshotUnreconstructableError';
  }
}

export class ModelCallContextLoader {
  constructor(private readonly store: ModelCallContextStore) {}

  async load(modelCallId: string): Promise<AgentModelCall> {
    const call = await this.store.getModelCall(modelCallId);
    if (!call) throw new Error(`ModelCall ${JSON.stringify(modelCallId)} was not found.`);
    return call;
  }

  reconstruct(call: AgentModelCall, material: ContextMaterial): BuiltContext {
    const groupIds = new Set(call.inputManifest.messageGroupIds);
    const summaryIds = new Set(call.inputManifest.summaryIds);
    const availableGroupIds = new Set(material.groups.map(item => item.group.id));
    const availableSummaryIds = new Set(material.summaries.map(item => item.id));
    const missingGroupIds = [...groupIds].filter(id => !availableGroupIds.has(id));
    const missingSummaryIds = [...summaryIds].filter(id => !availableSummaryIds.has(id));
    if (missingGroupIds.length > 0 || missingSummaryIds.length > 0) {
      throw new ContextSnapshotUnreconstructableError(
        `ModelCall ${JSON.stringify(call.id)} references unavailable context material: `
        + `groups=${JSON.stringify(missingGroupIds)}, summaries=${JSON.stringify(missingSummaryIds)}.`
      );
    }
    const built = compileContext({
      ...material,
      groups: material.groups.filter(item => groupIds.has(item.group.id)),
      summaries: material.summaries.filter(item => summaryIds.has(item.id)),
      model: {
        provider: call.provider,
        name: call.model,
        maxContextTokens: call.maxContextTokens,
        reservedOutputTokens: call.reservedOutputTokens,
      },
      audit: {
        purpose: call.inputManifest.purpose,
        contextRulesVersion: call.inputManifest.contextRulesVersion,
        systemPromptVersion: call.inputManifest.systemPromptVersion,
      },
      compression: {
        disabled: true,
        newCompressibleMessageCount: 0,
        messageThreshold: Number.MAX_SAFE_INTEGER,
      },
    });
    this.verify(call, built);
    return built;
  }

  private verify(call: AgentModelCall, built: BuiltContext): void {
    const manifest = built.inputManifest;
    if (
      manifest.fixedPrefixChecksum !== call.inputManifest.fixedPrefixChecksum
      || manifest.toolSchemaChecksum !== call.inputManifest.toolSchemaChecksum
      || JSON.stringify(manifest.messageGroupIds) !== JSON.stringify(call.inputManifest.messageGroupIds)
      || JSON.stringify(manifest.summaryIds) !== JSON.stringify(call.inputManifest.summaryIds)
    ) {
      throw new ContextSnapshotUnreconstructableError(
        `ModelCall ${JSON.stringify(call.id)} cannot be reconstructed from its persisted manifest.`
      );
    }
    const serialized = JSON.stringify(built.messages.map(message => message.toDict()));
    const checksum = createHash('sha256').update(serialized).digest('hex');
    if (checksum !== call.inputChecksum) {
      throw new ContextSnapshotUnreconstructableError(
        `ModelCall ${JSON.stringify(call.id)} cannot be reconstructed from its persisted manifest.`
      );
    }
  }
}
