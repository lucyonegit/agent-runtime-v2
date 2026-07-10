import type {
  AgentMessage,
  AgentSessionPatch,
} from '../domain/index.js';
import {
  defaultIdFactory,
  type IdFactory,
} from './types.js';

interface SessionEventEmitterConfig {
  ids?: IdFactory;
  onEvent?: (event: AgentSessionPatch) => void | Promise<void>;
}

export class SessionEventEmitter {
  private readonly createId: IdFactory;
  private readonly pendingAssistantMessageIds = new Map<string, string>();

  constructor(private readonly config: SessionEventEmitterConfig) {
    this.createId = config.ids ?? defaultIdFactory;
  }

  async emit(patch: AgentSessionPatch): Promise<void> {
    await this.config.onEvent?.(patch);
  }

  getPendingAssistantMessageId(
    taskId: string,
    channel: AgentMessage['channel'],
    outputId: string
  ): string {
    const key = this.pendingAssistantMessageKey(taskId, channel, outputId);
    let id = this.pendingAssistantMessageIds.get(key);
    if (!id) {
      id = this.createId('msg');
      this.pendingAssistantMessageIds.set(key, id);
    }
    return id;
  }

  consumePendingAssistantMessageId(
    taskId: string,
    channel: AgentMessage['channel'],
    outputId: string
  ): string {
    const key = this.pendingAssistantMessageKey(taskId, channel, outputId);
    const existing = this.pendingAssistantMessageIds.get(key);
    if (existing) {
      this.pendingAssistantMessageIds.delete(key);
      return existing;
    }
    return this.createId('msg');
  }

  private pendingAssistantMessageKey(
    taskId: string,
    _channel: AgentMessage['channel'],
    outputId: string
  ): string {
    return `${taskId}:output:${outputId}`;
  }
}
