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
  currentInvariantsSnapshotId?: string;
  currentIndexSnapshotId?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
