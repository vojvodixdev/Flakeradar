import type {
  ApiError,
  CreatedProject,
  ProjectListItem,
  ProjectOverview,
  RunListItem,
  TestDetail,
  TestListItem,
} from '@flakeradar/core';

const ADMIN_TOKEN_KEY = 'flakeradar.adminToken';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
    else localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // Storage can be unavailable (private mode); the token then lives for this page only.
  }
}

let adminToken = readStoredToken();

/**
 * Set by the app shell. Called when an admin-only action is rejected, so the
 * user can enter the admin token. Resolves to the token, or null if cancelled.
 */
let requestAdminToken: (() => Promise<string | null>) | null = null;
export function onAdminTokenNeeded(handler: () => Promise<string | null>): void {
  requestAdminToken = handler;
}

async function request<T>(method: string, path: string, body?: unknown, admin = false): Promise<T> {
  const send = () =>
    fetch(path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(admin && adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await send();

  if (res.status === 401 && admin && requestAdminToken) {
    const token = await requestAdminToken();
    if (token) {
      adminToken = token;
      storeToken(token);
      res = await send();
    }
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ApiError | null;
    if (res.status === 401 && admin) storeToken((adminToken = null));
    throw new ApiRequestError(res.status, err?.error ?? 'http_error', err?.message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  projects: () => request<ProjectListItem[]>('GET', '/api/projects'),
  createProject: (input: { name: string; repository?: string; defaultBranch?: string }) =>
    request<CreatedProject>('POST', '/api/projects', input, true),
  rotateToken: (slug: string) => request<CreatedProject>('POST', `/api/projects/${enc(slug)}/token`, {}, true),
  overview: (slug: string) => request<ProjectOverview>('GET', `/api/projects/${enc(slug)}`),
  tests: (slug: string, params: { status?: string; q?: string; sort?: string }) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return request<TestListItem[]>('GET', `/api/projects/${enc(slug)}/tests?${qs}`);
  },
  test: (slug: string, id: number) => request<TestDetail>('GET', `/api/projects/${enc(slug)}/tests/${id}`),
  setQuarantine: (slug: string, id: number, quarantined: boolean) =>
    request<TestDetail>('PATCH', `/api/projects/${enc(slug)}/tests/${id}`, { quarantined }, true),
  runs: (slug: string) => request<RunListItem[]>('GET', `/api/projects/${enc(slug)}/runs?limit=100`),
};
