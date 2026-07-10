export type AgentCodeProjectStatus = 'active' | 'archived' | 'deleted';

export interface AgentCodeProject {
  id: string;
  sessionId: string;
  title: string;
  status: AgentCodeProjectStatus;
  sandboxRelativePath: string;
  framework?: string;
  language?: string;
  packageManager?: string;
  version: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
}
