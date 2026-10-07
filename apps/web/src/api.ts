/** The server's API, from the browser (same origin, session cookie). */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        // Proves this isn't a cross-site form post (the server refuses changes without it).
        'x-workspace-client': 'web',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'offline', 'Can’t reach the server. Check your connection.');
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(
      response.status,
      data?.error ?? 'error',
      data?.message ?? `The server answered ${response.status}.`,
    );
  }
  return (await response.json()) as T;
}

export interface Me {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

export interface ServerInfo {
  signup: 'open' | 'invite' | 'disabled';
  needsSetup: boolean;
  providers: { id: string; name: string }[];
}

export interface RemoteWorkspace {
  id: string;
  name: string;
  role: string;
}

export const me = async (): Promise<Me | null> => {
  try {
    return (await api<{ user: Me }>('GET', '/api/auth/me')).user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
};
