// 统一请求入口：浏览器只访问同源 /api，由 next.config.mjs 代理到 Flask。
// Flask session 认证依赖 Cookie，因此所有请求必须 credentials: "include"。

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function isFormData(body: unknown): body is FormData {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

function normalizeBody(body: unknown): BodyInit | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (isFormData(body)) {
    return body;
  }
  if (typeof body === 'string') {
    return body;
  }
  return JSON.stringify(body);
}

async function readPayload(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) {
    return null;
  }
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function resolveErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const raw = (payload as { error?: unknown }).error;
    if (typeof raw === 'string' && raw.trim()) {
      return raw;
    }
  }
  return `请求失败（${status}）`;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const hasBody = init.body != null;
  if (hasBody && !isFormData(init.body) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers,
  });
  const payload = await readPayload(response);

  if (!response.ok) {
    throw new ApiError(resolveErrorMessage(payload, response.status), response.status);
  }
  return payload as T;
}

export function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  return apiFetch<T>(path, { ...init, method: 'GET' });
}

export function postJson<T>(
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  return apiFetch<T>(path, {
    ...init,
    method: 'POST',
    body: normalizeBody(body),
  });
}

export function del<T>(path: string, init?: RequestInit): Promise<T> {
  return apiFetch<T>(path, { ...init, method: 'DELETE' });
}

export function putJson<T>(
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  return apiFetch<T>(path, {
    ...init,
    method: 'PUT',
    body: normalizeBody(body),
  });
}

// 兼容语义化别名，便于后续页面按 apiGet/apiPost 习惯调用。
export const apiGet = getJson;
export const apiPost = postJson;
export const apiDelete = del;
