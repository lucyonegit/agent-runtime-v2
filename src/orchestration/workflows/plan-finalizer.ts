import type { AgentJob } from '../../domain/index.js';
import type { PlanEngine } from '../../planner/plan-engine.js';

export class PlanFinalizer {
  async finalize(engine: PlanEngine, job: AgentJob, originalGoal: string): Promise<void> {
    const temporal = currentTemporalContext();
    await engine.finalize(job, originalGoal, temporal.currentDate, temporal.timezone);
  }
}

function currentTemporalContext(): { currentDate: string; timezone: string } {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { currentDate: `${values.year}-${values.month}-${values.day}`, timezone };
}

