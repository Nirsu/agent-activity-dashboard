import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnalysisResults } from '../ui/src/components/brain/AnalysisResults';
import { AnalysisSetup } from '../ui/src/components/brain/AnalysisSetup';
import { ReviewDossier } from '../ui/src/components/brain/ReviewDossier';
import type { Analysis, Finding, Project } from '../ui/src/components/brain/types';

const finding: Finding = {
  id: 'finding',
  title: 'Export date',
  outcome: 'difference',
  explanation: 'The selected code omits the date.',
  question: 'Should the date be restored?',
  limitation: 'Only the captured files were examined.',
  decision: { sourceId: 'spec', line: 2, quote: 'Conserver la date des exports.' },
  evidence: [],
  reviews: [],
};
const analysis: Analysis = {
  id: 'run',
  projectId: 'dashboard',
  projectName: 'Dashboard',
  status: 'succeeded',
  stage: 'Analysis complete · decisions require human review',
  startedAt: '2026-09-16T12:00:00Z',
  model: 'test-model',
  events: [
    'Capturing sources',
    'Reading project specifications',
    'Comparing captured code',
    'Preparing human review',
  ].map((message) => ({ at: '2026-09-16T12:00:00Z', message })),
  usage: { inputTokens: 0, outputTokens: 0 },
  findingCount: 1,
  current: true,
  sources: [],
  requirements: [],
  findings: [finding],
};

function results(run: Analysis, detail: Analysis | null = run, detailError?: string) {
  return renderToStaticMarkup(
    <AnalysisResults
      configured
      runs={[run]}
      selectedRun={run}
      detail={detail}
      detailError={detailError}
      finding={detail?.findings[0]}
      busy={false}
      locked={false}
      onSelectRun={() => {}}
      onSelectFinding={() => {}}
      onOpenSource={() => {}}
      onSaveReview={async () => {}}
      onRetryDetail={async () => {}}
      onPrepareRetry={() => {}}
    />,
  );
}

test('failed and running analyses never present partial findings as completed reviews', () => {
  for (const status of ['failed', 'running'] as const) {
    const html = results({
      ...analysis,
      status,
      stage: 'Reading project specifications',
      events: analysis.events.slice(0, 2),
    });
    assert.doesNotMatch(html, /Export date|Save review|Findings by outcome/);
    if (status === 'failed') {
      assert.match(html, /Reuse this setup/);
      assert.match(html, /Stopped/);
      assert.match(html, /role="status">Analysis stopped before completion/);
      assert.doesNotMatch(html, /role="status">Reading project specifications/);
      assert.equal((html.match(/· Not run/g) ?? []).length, 2);
    } else {
      assert.match(html, /aria-current="step"/);
      assert.match(html, /Findings will appear when all analysis stages finish/);
      assert.equal((html.match(/· Waiting/g) ?? []).length, 2);
    }
  }
});

test('a run without requirements does not imply comparison or arbitration ran', () => {
  const html = results({ ...analysis, events: analysis.events.slice(0, 2), findings: [] });
  assert.match(html, /No applicable requirements found/);
  assert.match(html, /There was nothing to compare against the code/);
  assert.equal((html.match(/· Not run/g) ?? []).length, 2);
  assert.doesNotMatch(html, /Save review|Findings by outcome/);
});

test('matches and insufficient evidence remain distinct from human decisions', () => {
  const match = results({ ...analysis, findings: [{ ...finding, outcome: 'aligned' }] });
  assert.match(match, /Observed matches/);
  assert.match(match, /not a human approval/);
  assert.match(match, /Conserver la date des exports/);
  assert.doesNotMatch(match, /Save review|HUMAN REVIEW QUESTION/);
  const insufficient = results({
    ...analysis,
    findings: [{ ...finding, outcome: 'insufficient' }],
  });
  assert.match(insufficient, /Brain cannot conclude from this evidence/);
  assert.doesNotMatch(insufficient, /Save review/);
});

test('detail failures offer retry instead of an endless loader and pause stale reviews', () => {
  const unavailable = results(analysis, null, 'Connection interrupted.');
  assert.match(unavailable, /Retry loading details/);
  assert.doesNotMatch(unavailable, /Loading details|Save review/);
  const stale = results(analysis, analysis, 'Connection interrupted.');
  assert.match(stale, /reviews are paused until they refresh/);
  assert.match(stale, /<select[^>]+id="decision-finding"[^>]+disabled=""/);
  assert.match(stale, /<textarea[^>]+id="note-finding"[^>]+disabled=""/);
  const historical = results({ ...analysis, current: false });
  assert.match(historical, /Read-only historical analysis/);
  assert.doesNotMatch(historical, /Save review|Awaiting human review/);
});

test('running setup locks editable scope while allowing navigation to the active run', () => {
  const project: Project = {
    id: 'dashboard',
    name: 'Dashboard',
    scope: 'Dashboard requirements',
    specifications: 1,
    codePaths: ['ui/src'],
  };
  const html = renderToStaticMarkup(
    <AnalysisSetup
      state={{
        configured: true,
        reason: '',
        model: 'test-model',
        projects: [project],
        runs: [{ ...analysis, status: 'running' }],
        activeRunId: analysis.id,
      }}
      projectId={project.id}
      project={project}
      commit=""
      baseCommit=""
      feature=""
      busy={false}
      locked
      onSelectProject={() => {}}
      onCommitChange={() => {}}
      onBaseCommitChange={() => {}}
      onFeatureChange={() => {}}
      onStart={async () => {}}
      onShowActiveRun={() => {}}
    />,
  );
  for (const id of ['brain-agent-feature', 'brain-agent-commit', 'brain-agent-base']) {
    assert.match(html, new RegExp(`<(?:textarea|input)[^>]+id="${id}"[^>]+disabled=""`));
  }
  assert.match(html, /View running analysis/);
  assert.match(html, /Uncommitted edits are not included/);
  assert.match(html, /<details class="brain-agents-scope">/);
});

test('historical dossiers retain evidence and decisions without offering a new approval', () => {
  const finding: Finding = {
    id: 'finding',
    title: 'Export dates',
    outcome: 'difference',
    explanation: 'The date is missing.',
    question: 'Is the omission intentional?',
    limitation: 'Only the selected commit was reviewed.',
    decision: { sourceId: 'page', line: 3, quote: 'Conserver la date des exports.' },
    evidence: [],
    reviews: [
      {
        id: 'review',
        decision: 'confirmed',
        note: 'Restore the export date.',
        at: '2026-09-16T18:00:00Z',
        actor: 'Session reviewer',
      },
    ],
  };
  const props = {
    finding,
    sources: [],
    reviewKey: 'run',
    disabled: false,
    onOpenSource: () => {},
    onSaveReview: async () => {},
  };
  const archive = renderToStaticMarkup(<ReviewDossier {...props} reviewAllowed={false} />);
  assert.match(archive, /Conserver la date des exports/);
  assert.match(archive, /Restore the export date/);
  assert.match(archive, /Session reviewer/);
  assert.doesNotMatch(archive, /<form|Save review/);
  const current = renderToStaticMarkup(<ReviewDossier {...props} reviewAllowed={true} />);
  assert.match(current, /Revise your review/);
  assert.match(current, /Save review/);
});
