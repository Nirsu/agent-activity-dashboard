import type { Source } from '../sources.js';

export type Project = {
  id: string;
  name: string;
  scope: string;
  repoPath: string;
  codePaths: string[];
  specs: { kind: 'notion' | 'git'; path: string }[];
};

export type Citation = {
  sourceId: string;
  line: number;
  quote: string;
};

export type Requirement = {
  id: string;
  statement: string;
  scope: string;
  citation: Citation;
};

export type ComparisonCheck = {
  requirementId: string;
  outcome: 'difference' | 'aligned' | 'insufficient';
  explanation: string;
  evidence: Citation[];
};

export type ArbitrationDossier = {
  requirementId: string;
  title: string;
  question: string;
  limitation: string;
};

export type HumanReview = {
  id: string;
  decision: string;
  note: string;
  at: string;
  actor: string;
};

export type Finding = {
  id: string;
  title: string;
  outcome: ComparisonCheck['outcome'];
  explanation: string;
  question: string;
  limitation: string;
  decision: Citation;
  evidence: Citation[];
  reviews: HumanReview[];
};

export type AnalysisRun = {
  id: string;
  projectId: string;
  projectName: string;
  scope: string;
  projectVersion: string;
  commit?: string;
  baseCommit?: string;
  requestTimeoutMs?: number;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  stage: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  model: string;
  provider?: string;
  promptVersion?: string;
  events: { at: string; message: string }[];
  usage: { inputTokens: number; outputTokens: number };
  sources: Source[];
  requirements: Requirement[];
  findings: Finding[];
  changedFiles: string[];
};

export type AgentRole = 'reader' | 'comparison' | 'arbitration';

export type ModelResult = {
  value: unknown;
  inputTokens: number;
  outputTokens: number;
  error?: string;
};

export type ModelCall = (
  role: AgentRole,
  prompt: string,
  input: unknown,
  schema: Record<string, unknown>,
) => Promise<ModelResult>;

export type BrainAgentsOptions = {
  dbPath?: string;
  projectsPath?: string;
  model?: string;
  apiKey?: string;
  requestTimeoutMs?: number;
  call?: ModelCall;
};
