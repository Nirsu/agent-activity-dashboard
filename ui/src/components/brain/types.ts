export type BrainSource = {
  id: string;
  kind: 'notion' | 'code';
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
  projectId: string;
  projectName: string;
  commit?: string;
  baseCommit?: string;
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

export type BrainTab = 'memory' | 'rules' | 'review' | 'runs' | 'agents';
export type DemoRule = {
  id: string;
  title: string;
  topic: string;
  description: string;
  scope: string;
  source: Citation;
  active: boolean;
  activationNote?: string;
  activatedAt?: string;
  version: string;
};
export type DemoFinding = Finding & {
  ruleId: string;
  commit: string;
  current: boolean;
  createdAt: string;
};
export type DemoRun = {
  id: string;
  kind: string;
  status: RunStatus;
  stage: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  events: RunEvent[];
};
export type DemoState = {
  engine: string;
  scope: string;
  repo: string;
  snapshot?: { importedAt: string; commit: string; excluded: string[] };
  sources: BrainSource[];
  rules: DemoRule[];
  runs: DemoRun[];
  activeRun: DemoRun | null;
  findings: DemoFinding[];
  comparisonReady: boolean;
};
export type SearchResult = {
  sourceId: string;
  title: string;
  kind: string;
  status: string;
  matches: { line: number; quote: string }[];
};
