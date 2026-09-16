export type BrainSource = {
  id: string;
  kind: 'notion' | 'code' | 'review';
  title: string;
  path: string;
  revision: string;
  status: 'published' | 'draft' | 'observed';
  topic: string;
  summary: string;
  lines: number;
  importedAt: string;
  content?: string;
  url?: string;
  origin?: { properties: Record<string, unknown>; revision?: string; raw?: string };
};

export type Citation = { sourceId: string; line: number; quote: string };
export type OpenSource = (sourceId: string, line?: number) => void;
export type SourceSelection = { source: BrainSource; line?: number };
export type Review = {
  id: string;
  decision: string;
  note: string;
  at: string;
  actor: string;
};
export type Finding = {
  id: string;
  requirementId?: string;
  title: string;
  outcome: 'difference' | 'aligned' | 'insufficient';
  explanation: string;
  question: string;
  limitation: string;
  decision: Citation;
  evidence: Citation[];
  reviews: Review[];
};
export type RunEvent = { at: string; message: string };
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';

export type Project = {
  id: string;
  name: string;
  scope: string;
  codePaths: string[];
  specifications: number;
};
export type AnalysisRun = {
  id: string;
  detailVersion?: string;
  projectId: string;
  projectName: string;
  commit?: string;
  baseCommit?: string;
  feature?: string;
  retrieval?: {
    datasets: string[];
    sourceIds: string[];
    retrievedAt: string;
    query: string;
    memoryVersion: string;
    contextVersion: string;
  };
  status: RunStatus;
  stage: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  model: string;
  events: RunEvent[];
  usage: { inputTokens: number; outputTokens: number };
  findingCount: number;
};
export type Analysis = AnalysisRun & {
  sources: BrainSource[];
  findings: Finding[];
  requirements: { id: string; statement: string; scope: string; citation: Citation }[];
  current: boolean;
};
export type AnalysesState = {
  configured: boolean;
  reason: string;
  model: string | null;
  projects: Project[];
  runs: AnalysisRun[];
  activeRunId: string | null;
};
