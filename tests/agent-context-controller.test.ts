import { describe, expect, it, vi } from 'vitest';
import type { ContextPreviewService } from '../src/server/debug/context-preview.service.js';
import { AgentContextController } from '../src/server/http/agent-context.controller.js';

describe('AgentContextController', () => {
  it('builds the selected Session next-turn Context preview', async () => {
    const preview = vi.fn(async () => ({
      schemaVersion: 2,
      debugOnly: true,
      sessionId: 'session_1',
      messages: [],
    }));
    const controller = new AgentContextController({ preview } as unknown as ContextPreviewService);

    await expect(controller.getSessionContextPreview('session_1')).resolves.toMatchObject({
      schemaVersion: 2,
      sessionId: 'session_1',
    });
    expect(preview).toHaveBeenCalledOnce();
    expect(preview).toHaveBeenCalledWith('session_1');
  });
});
