export type AgentSessionMode = 'agent' | 'code';
export type AgentSessionStatus = 'active' | 'archived';

export interface AgentSession {
  id: string;
  title?: string;
  mode: AgentSessionMode;
  status: AgentSessionStatus;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}
