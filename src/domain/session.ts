export type AgentSessionMode = 'planner_react' | 'code';
export type AgentSessionStatus = 'active' | 'archived';

export interface AgentSession {
  id: string;
  title?: string;
  mode: AgentSessionMode;
  status: AgentSessionStatus;
  createdAt: number;
  updatedAt: number;
}
