import { apiFetch } from '../../api/ws';

export async function brainRequest<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const options =
    body === undefined
      ? undefined
      : {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        };
  const response = await apiFetch(`/api/brain${path}`, options);
  const data = await response.json();
  if (!response.ok) {
    const message =
      data.error === 'unauthorized'
        ? 'Access denied: check the dashboard token.'
        : (data.message ?? data.error ?? 'The request failed.');
    throw new Error(message);
  }
  return data as T;
}
