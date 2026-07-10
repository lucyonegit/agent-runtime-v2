import { AgentRuntime } from './agent-runtime.js';

export class CodeAgent {
  constructor(private readonly runtime: AgentRuntime) {}

  createSession(title?: string) {
    return this.runtime.createSession({ title, mode: 'code' });
  }

  createJob(input: {
    sessionId: string;
    message: string;
    projectId: string;
    clientRequestId: string;
  }) {
    return this.runtime.createJob(input);
  }
}
