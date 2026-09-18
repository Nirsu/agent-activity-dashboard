import type { Source } from '../sources.js';
import type { MemoryService } from '../memory/service.js';
import type { RetrievedEvidence } from '../memory/types.js';

export type Project = {
  id: string;
  name: string;
  scope: string;
  repoPath: string;
  codePaths: string[];
  specs: { kind: 'git'; path: string }[];
};

export type Citation = {
  sourceId: string;
  line: number;
  endLine?: number;
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
  requirementId?: string;
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
  feature?: string;
  submission?: { id: string; baselineCommit: string; paths: string[] };
  retrieval?: Omit<RetrievedEvidence, 'sources'>;
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
  correlation?: BrainCorrelation;
  calls?: BrainModelCall[];
};

export type BrainCorrelation = {
  workItemId?: string;
  ticket?: string;
  originSessionId?: string;
  parentRunId?: string;
};

export type BrainModelCall = {
  id: string;
  role: AgentRole;
  model: string;
  responseId?: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  usageKnown: boolean;
  costUsd: number | null;
};

export type BrainActivity = BrainCorrelation & {
  id: string;
  ts: number;
  kind: 'brain_analysis' | 'brain_model_call' | 'brain_review';
  phase: 'started' | 'progress' | 'completed' | 'failed' | 'interrupted';
  runId: string;
  projectId: string;
  projectName: string;
  model: string;
  stage: string;
  role?: AgentRole;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  usageKnown?: boolean;
  costUsd?: number | null;
  startedAt?: string;
  finishedAt?: string;
  findingCount?: number;
  differenceCount?: number;
};

export type SubmittedFile = { path: string; content: string | null };

export type AgentRole = 'reader' | 'comparison' | 'arbitration';

export type ModelResult = {
  value: unknown;
  inputTokens: number;
  outputTokens: number;
  error?: string;
  usageKnown?: boolean;
  model?: string;
  responseId?: string;
  cachedInputTokens?: number;
  reasoningTokens?: number;
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
  memory?: Pick<MemoryService, 'retrieve' | 'version' | 'contextVersion' | 'recordReview'>;
  onActivity?: (event: BrainActivity) => Promise<void>;
};
