/** The sync server's HTTP API, as the desktop uses it. */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

export interface ServerInfo {
  signup: 'open' | 'invite' | 'disabled';
  needsSetup: boolean;
  providers: { id: string; name: string }[];
}

export interface Account {
  id: string;
  email: string;
  name: string;
}

export interface RemoteWorkspace {
  id: string;
  name: string;
  role: string;
}

/** A refusal from the server, with its message (shown to the user as is). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;

/** `https://host/` → `https://host`; throws on anything but http(s). */
export function normalizeServerUrl(input: string): string {
  let raw = input.trim();
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ApiError(0, 'invalid', 'Enter the server’s address, like https://notes.example.com');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export class ServerApi {
  constructor(
    readonly baseUrl: string,
    private token: string | null = null,
  ) {}

  setToken(token: string | null) {
    this.token = token;
  }

  /** `ws(s)://…/api/sync/<workspace>` */
  syncUrl(workspaceId: string): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/api/sync/${workspaceId}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init: RequestInit = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      // Proof (with no cookie involved) that this isn't a cross-site form post.
      'x-workspace-client': 'desktop',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        ...init,
        headers,
        body: body === undefined ? init.body : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ApiError(0, 'unreachable', `Can’t reach the server (${reason}).`);
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
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** Any API call (the team routes the renderer asks for, after checking the path). */
  call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.request<T>(method, path, body);
  }

  info(): Promise<ServerInfo> {
    return this.request('GET', '/api/auth/config');
  }

  login(email: string, password: string, deviceName: string) {
    return this.request<{ user: Account; token: string }>('POST', '/api/auth/login', {
      email,
      password,
      client: 'desktop',
      deviceName,
    });
  }

  signup(
    input: { email: string; name: string; password: string; invite?: string },
    deviceName: string,
  ) {
    return this.request<{ user: Account; token: string }>('POST', '/api/auth/signup', {
      ...input,
      client: 'desktop',
      deviceName,
    });
  }

  exchange(code: string, verifier: string, deviceName: string) {
    return this.request<{ user: Account; token: string }>('POST', '/api/auth/desktop/exchange', {
      code,
      verifier,
      deviceName,
    });
  }

  async me(): Promise<Account> {
    return (await this.request<{ user: Account }>('GET', '/api/auth/me')).user;
  }

  async logout(): Promise<void> {
    await this.request('POST', '/api/auth/logout', {});
  }

  async workspaces(): Promise<RemoteWorkspace[]> {
    return (await this.request<{ workspaces: RemoteWorkspace[] }>('GET', '/api/workspaces'))
      .workspaces;
  }

  async createWorkspace(name: string): Promise<RemoteWorkspace> {
    return (await this.request<{ workspace: RemoteWorkspace }>('POST', '/api/workspaces', { name }))
      .workspace;
  }

  // --- Attachments ---------------------------------------------------------------------

  private fileUrl(workspaceId: string, fileId: string) {
    return `${this.baseUrl}/api/workspaces/${workspaceId}/files/${fileId}`;
  }

  /** Whether the server has the file. */
  async hasFile(workspaceId: string, fileId: string): Promise<boolean> {
    const response = await fetch(this.fileUrl(workspaceId, fileId), {
      method: 'HEAD',
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new ApiError(response.status, 'error', `HEAD ${response.status}`);
    return true;
  }

  /** Upload a stored file (streamed from disk). */
  async putFile(
    workspaceId: string,
    file: { id: string; name: string; mime: string },
    path: string,
  ): Promise<void> {
    const response = await fetch(this.fileUrl(workspaceId, file.id), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name),
        'x-file-mime': file.mime,
      },
      body: Readable.toWeb(createReadStream(path)) as ReadableStream,
      // Node's fetch needs this to send a stream.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        message?: string;
      } | null;
      throw new ApiError(
        response.status,
        data?.error ?? 'error',
        data?.message ?? `PUT ${response.status}`,
      );
    }
  }

  /** Download a file: its bytes, name and type, or null if the server doesn't have it. */
  async getFile(
    workspaceId: string,
    fileId: string,
  ): Promise<{ bytes: Uint8Array; name: string; mime: string } | null> {
    const response = await fetch(this.fileUrl(workspaceId, fileId), {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new ApiError(response.status, 'error', `GET ${response.status}`);
    let name = 'Untitled';
    try {
      name = decodeURIComponent(response.headers.get('x-file-name') ?? '') || name;
    } catch {
      // Keep the default.
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      name,
      mime: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}
