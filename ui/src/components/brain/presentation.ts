export const statusLabels: Record<string, string> = {
  published: 'Published · export',
  draft: 'Proposal / scope',
  observed: 'Observed code',
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

export function formatDate(value: string, timeStyle: 'short' | 'medium' = 'short') {
  return new Date(value).toLocaleString('en-GB', { dateStyle: 'short', timeStyle });
}
