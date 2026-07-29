import { createSideEffectConfirmationSchema } from '../../domain/index.js';
import type { SideEffectConfirmationRequestDraft } from '../../storage/agent-store.js';

export function createSideEffectConfirmationRequest(input: {
  requestId: string;
  toolName: string;
  reason: 'runtime_failure' | 'service_restart';
}): SideEffectConfirmationRequestDraft {
  const interruption = input.reason === 'service_restart'
    ? 'the service restarted'
    : 'execution stopped';
  return {
    requestId: input.requestId,
    title: 'Confirm operation outcome',
    prompt: [
      `The outcome of ${input.toolName} is unknown because ${interruption} after the operation began.`,
      'Did the operation take effect?',
    ].join(' '),
    inputSchema: createSideEffectConfirmationSchema(),
    metadata: { reason: 'side_effect_outcome_unknown' },
  };
}
