export type AgentSessionStatus = 'active' | 'archived';

export interface AgentSession {
  id: string;
  title?: string;
  status: AgentSessionStatus;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}
