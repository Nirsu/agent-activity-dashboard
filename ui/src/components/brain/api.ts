import { apiFetch } from '../../api/ws';

let adminToken = '';

export function setBrainAdminToken(value: string) {
  adminToken = value;
}

export function hasBrainAdminToken() {
  return Boolean(adminToken);
}

export function brainAdminRequest<T>(path: string, body?: unknown, method = 'POST') {
  return brainRequest<T>(path, body, method, true);
}

export async function brainRequest<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  administrative = false,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (administrative && adminToken) {
    headers['x-brain-admin-token'] = adminToken;
  }
  const options = {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  let response: Response;
  try {
    response = await apiFetch(`/api/brain${path}`, options);
  } catch {
    throw new Error('Cannot reach Brain. Check the server connection and try again.');
  }
  let data: Record<string, unknown> = {};
  if (response.status !== 204) {
    try {
      data = await response.json();
    } catch {
      throw new Error(
        `Brain returned an unreadable response (HTTP ${response.status}). Try again.`,
      );
    }
  }
  if (!response.ok) {
    const message =
      data.error === 'unauthorized'
        ? 'Access denied: check the dashboard token.'
        : (data.message ?? data.error ?? 'The request failed.');
    throw Object.assign(new Error(typeof message === 'string' ? message : 'The request failed.'), {
      status: response.status,
    });
  }
  return data as T;
}
