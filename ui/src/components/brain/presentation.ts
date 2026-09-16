import type { MemorySource } from './memoryTypes';

export const statusLabels: Record<string, string> = {
  difference: 'Suspected difference',
  aligned: 'Observed match',
  insufficient: 'Insufficient evidence',
  running: 'Running',
  succeeded: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  confirmed: 'Code needs correction',
  documentation: 'Documentation needs updating',
  false_positive: 'False positive',
  exception: 'Accepted exception',
  investigate: 'Needs investigation',
};

export function formatDate(value: string) {
  return new Date(value).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
}

export function memorySourceStatus(source: MemorySource) {
  return source.approval === 'draft' && source.currentSourceId && source.status === 'pending'
    ? 'Awaiting approval'
    : source.status;
}

export function memorySourceExplanation(source: MemorySource) {
  if (source.status === 'ready' || source.approval === 'withdrawn') {
    return '';
  }
  if (source.approval === 'draft' && source.currentSourceId && source.status === 'pending') {
    return 'Captured for inspection. Approve before indexing and analysis.';
  }
  return source.currentSourceId
    ? 'The latest synchronization is incomplete. The last captured version remains available for inspection.'
    : 'This source is not available to analyses until capture and indexing succeed.';
}
