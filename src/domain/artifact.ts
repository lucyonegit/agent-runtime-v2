export type AgentArtifactKind = 'file';
export type AgentArtifactArea = 'code' | 'docs' | 'artifacts' | 'downloads';

export interface AgentArtifactDraft {
  kind: AgentArtifactKind;
  area: AgentArtifactArea;
  title: string;
  fileName: string;
  logicalPath: string;
  storagePath: string;
  mediaType: string;
  size: number;
  checksum: string;
  metadata?: Record<string, unknown>;
}

/**
 * An immutable snapshot produced by a tool invocation. logicalPath is the
 * user-facing workspace path; storagePath points at the revision snapshot so
 * an older conversation card never changes when the logical file is updated.
 */
export interface AgentArtifact {
  id: string;
  sessionId: string;
  jobId: string;
  planId?: string;
  planStepId?: string;
  toolInvocationId: string;
  resultMessageId: string;
  kind: AgentArtifactKind;
  area: AgentArtifactArea;
  title: string;
  fileName: string;
  logicalPath: string;
  storagePath: string;
  mediaType: string;
  size: number;
  checksum: string;
  revision: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
}
