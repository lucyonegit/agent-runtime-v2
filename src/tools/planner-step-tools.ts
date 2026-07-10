import type { RuntimeTool } from './types.js';
import { completedJson, failed, stringArg } from './types.js';

export const SUBMIT_STEP_RESULT_TOOL = 'submit_step_result';

export interface SubmittedStepResult {
  type: 'step_result_submitted';
  stepId?: string;
  summary: string;
  findings?: string[];
  evidence?: Array<{
    title?: string;
    url?: string;
    source?: string;
    note?: string;
  }>;
  limitations?: string[];
  nextContext?: string;
}

export function createPlannerStepTools(): RuntimeTool[] {
  return [
    {
      name: SUBMIT_STEP_RESULT_TOOL,
      description: 'Submit the stable result for the current planner step. Only use this when a planner step is complete.',
      parameters: {
        type: 'object',
        properties: {
          stepId: {
            type: 'string',
            description: 'The current planner step id, for example step_1.',
          },
          summary: {
            type: 'string',
            description: 'Stable step result used by later steps and final synthesis. Do not include raw tool JSON.',
          },
          findings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Important facts or conclusions produced by this step.',
          },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                url: { type: 'string' },
                source: { type: 'string' },
                note: { type: 'string' },
              },
              additionalProperties: false,
            },
            description: 'Compact source evidence. Use titles, URLs, or notes, not raw tool payloads.',
          },
          limitations: {
            type: 'array',
            items: { type: 'string' },
            description: 'Known uncertainty, failed lookups, or caveats.',
          },
          nextContext: {
            type: 'string',
            description: 'Optional context that will help the next planner step.',
          },
        },
        required: ['summary'],
        additionalProperties: false,
      },
      execute: async args => {
        const summary = stringArg(args, 'summary').trim();
        if (!summary) {
          return failed(`${SUBMIT_STEP_RESULT_TOOL} requires a non-empty summary.`);
        }

        return completedJson({
          type: 'step_result_submitted',
          stepId: stringArg(args, 'stepId').trim() || undefined,
          summary,
          findings: stringArrayArg(args.findings),
          evidence: evidenceArrayArg(args.evidence),
          limitations: stringArrayArg(args.limitations),
          nextContext: stringArg(args, 'nextContext').trim() || undefined,
        } satisfies SubmittedStepResult);
      },
    },
  ];
}

function stringArrayArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function evidenceArrayArg(value: unknown): SubmittedStepResult['evidence'] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const evidence = {
      title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : undefined,
      url: typeof record.url === 'string' && record.url.trim() ? record.url.trim() : undefined,
      source: typeof record.source === 'string' && record.source.trim() ? record.source.trim() : undefined,
      note: typeof record.note === 'string' && record.note.trim() ? record.note.trim() : undefined,
    };
    return evidence.title || evidence.url || evidence.source || evidence.note ? [evidence] : [];
  });

  return items.length > 0 ? items : undefined;
}
