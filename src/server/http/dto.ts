export interface RunReactBody {
  input: string;
}

export interface RunPlannerReactBody {
  goal: string;
}

export interface RunCodeBody {
  input: string;
  projectId?: string;
  projectTitle?: string;
}

export interface AnswerInputRequestBody {
  value: unknown;
}

export interface CreateSessionBody {
  id?: string;
  title?: string;
  mode?: 'planner_react' | 'code';
}
