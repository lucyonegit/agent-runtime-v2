import { createHash } from 'node:crypto';
import { mapStoredMessagesToChatMessages } from '@langchain/core/messages';
import type { AgentModelCall } from '../../domain/index.js';
import type { AgentStore } from '../../storage/agent-store.js';
import {
  compileContext,
  CONTEXT_RULES_VERSION,
  type BuiltContext,
} from '../context/context-compiler.js';
import type { ContextMaterial } from '../context/context-material.js';
import { canonicalJson } from '../transaction-commands.js';

export type ModelCallContextStore = Pick<AgentStore, 'getModelCall'>;

class ContextSnapshotUnreconstructableError extends Error {
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
    if (call.inputManifest.contextRulesVersion !== CONTEXT_RULES_VERSION) {
      throw new ContextSnapshotUnreconstructableError(
        `ModelCall ${JSON.stringify(call.id)} uses unsupported context rules `
        + `${JSON.stringify(call.inputManifest.contextRulesVersion)}.`
      );
    }
    const groupIds = new Set(call.inputManifest.messageGroupIds);
    const summaryIds = new Set(call.inputManifest.summaryIds);
    const sourceGroups = material.groups;
    const availableGroupIds = new Set(sourceGroups.map(item => item.group.id));
    const availableSummaryIds = new Set(material.summaries.map(item => item.id));
    const missingGroupIds = [...groupIds].filter(id => !availableGroupIds.has(id));
    const missingSummaryIds = [...summaryIds].filter(id => !availableSummaryIds.has(id));
    if (missingGroupIds.length > 0 || missingSummaryIds.length > 0) {
      throw new ContextSnapshotUnreconstructableError(
        `ModelCall ${JSON.stringify(call.id)} references unavailable context material: `
        + `groups=${JSON.stringify(missingGroupIds)}, summaries=${JSON.stringify(missingSummaryIds)}.`
      );
    }
    const selectedBundleIds = new Set(call.inputManifest.selectedBundleIds ?? []);
    const selectedGroups = sourceGroups.filter(item => groupIds.has(item.group.id));
    const reconstructed = compileContext({
      ...material,
      groups: selectedGroups,
      bundles: (material.bundles ?? [])
        .filter(item => selectedBundleIds.has(item.bundle.id))
        .map(item => ({
          ...item,
          mustKeep: true,
          bundle: {
            ...item.bundle,
            groups: item.bundle.groups.filter(group => groupIds.has(group.id)),
          },
        })),
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
    this.verifyManifest(call, reconstructed);
    const serialized = canonicalJson(call.inputMessages);
    if (createHash('sha256').update(serialized).digest('hex') !== call.inputChecksum) {
      throw new ContextSnapshotUnreconstructableError(
        `ModelCall ${JSON.stringify(call.id)} persisted input checksum is invalid.`
      );
    }
    const messages = mapStoredMessagesToChatMessages(call.inputMessages);
    return {
      ...reconstructed,
      messages,
      inputManifest: call.inputManifest,
      estimatedInputTokens: call.estimatedInputTokens,
      annotations: messages.map((_, index) => (
        reconstructed.annotations[index] ?? { groupId: `model_call:${call.id}:input:${index}` }
      )),
    };
  }

  private verifyManifest(call: AgentModelCall, built: BuiltContext): void {
    const manifest = built.inputManifest;
    if (
      manifest.fixedPrefixChecksum !== call.inputManifest.fixedPrefixChecksum
      || manifest.toolSchemaChecksum !== call.inputManifest.toolSchemaChecksum
      || JSON.stringify(manifest.messageGroupIds) !== JSON.stringify(call.inputManifest.messageGroupIds)
      || JSON.stringify(manifest.summaryIds) !== JSON.stringify(call.inputManifest.summaryIds)
      || JSON.stringify(manifest.selectedBundleIds ?? [])
        !== JSON.stringify(call.inputManifest.selectedBundleIds ?? [])
      || JSON.stringify(manifest.truncatedToolResultMessageIds ?? [])
        !== JSON.stringify(call.inputManifest.truncatedToolResultMessageIds ?? [])
    ) {
      throw new ContextSnapshotUnreconstructableError(
        `ModelCall ${JSON.stringify(call.id)} cannot be reconstructed from its persisted manifest.`
      );
    }
  }
}
