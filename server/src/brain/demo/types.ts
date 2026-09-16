export type Citation = { sourceId: string; line: number; quote: string };
export type Rule = {
  id: string;
  title: string;
  topic: string;
  description: string;
  scope: string;
  source: Citation;
  sourceRevision: string;
  active: boolean;
  activatedAt?: string;
  activationNote?: string;
  version: string;
};
export type Outcome = 'difference' | 'aligned' | 'insufficient';
export type Finding = {
  id: string;
  ruleId: string;
  ruleVersion: string;
  title: string;
  outcome: Outcome;
  explanation: string;
  question: string;
  limitation: string;
  decision: Citation;
  evidence: Citation[];
  commit: string;
  runId: string;
  createdAt: string;
};
export const decisions = [
  'confirmed',
  'documentation',
  'false_positive',
  'exception',
  'investigate',
] as const;
export type Review = {
  id: string;
  findingId: string;
  decision: (typeof decisions)[number];
  note: string;
  at: string;
  actor: string;
};
export type Run = {
  id: string;
  kind: 'import' | 'compare';
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  stage: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  commit?: string;
  sourceIds?: string[];
  findingIds?: string[];
  events: { at: string; message: string }[];
};
export type Snapshot = {
  id: string;
  importedAt: string;
  commit: string;
  sourceIds: string[];
  excluded: string[];
};
export type Options = {
  dbPath?: string;
  repoPath?: string;
  notionPath?: string;
  gitBinary?: string;
};
