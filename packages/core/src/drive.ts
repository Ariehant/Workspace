/**
 * Google Drive files (Phase 8 N9): a page points at a file in someone's Drive, picked with
 * Google's own Picker. The block keeps the file's id and what Drive last said about it (name,
 * type, size, when it changed), so it shows offline and on the web; the desktop asks Drive
 * again when the page is shown.
 *
 * The app asks Google only for `drive.file`: it sees the files people pick, nothing else.
 */

/** A pointer to a Drive file, as a block keeps it. */
export interface DriveFileRef {
  fileId: string;
  name: string;
  mimeType: string;
  /** When it last changed and its size (Google Docs have none), as Drive last said. */
  modifiedAt: number | null;
  size: number | null;
}

/** What a Drive file is now. */
export type DriveFileStatus =
  | { state: 'found'; file: DriveFileRef }
  /** Deleted or in the trash. */
  | { state: 'gone' }
  /** The account connected here can't see it (someone else's, not shared). */
  | { state: 'noAccess' }
  /** No Google account connected on this computer. */
  | { state: 'notConnected' }
  /** Drive couldn't be reached (offline). */
  | { state: 'offline' };

/** The owner's Google Cloud client: OAuth (a desktop app's), and the Picker's key and app id. */
export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
  apiKey: string;
  /** The Cloud project's number. */
  appId: string;
}

/** Google on this computer, for Settings → Connections (secrets aren't sent back). */
export interface GoogleState {
  /** A client is set (here, or by the build). */
  configured: boolean;
  /** The build brings it (it can't be changed here). */
  fromEnvironment: boolean;
  clientId: string;
  appId: string;
  hasSecret: boolean;
  hasApiKey: boolean;
  /** Connected as (null: not connected; '' when Google didn't say). */
  email: string | null;
  /** The token is encrypted by the OS keyring. */
  secure: boolean;
}

/** Drive file ids: letters, digits, `-` and `_`. */
const DRIVE_ID = /^[\w-]{10,200}$/;

export const isDriveFileId = (id: unknown): id is string =>
  typeof id === 'string' && DRIVE_ID.test(id);

/** Where a Drive file opens in the browser (built from its id, never from a page's URL). */
export function driveOpenUrl(fileId: string): string {
  return `https://drive.google.com/open?id=${encodeURIComponent(fileId)}`;
}

const KINDS: Record<string, string> = {
  'application/vnd.google-apps.document': 'Google Docs',
  'application/vnd.google-apps.spreadsheet': 'Google Sheets',
  'application/vnd.google-apps.presentation': 'Google Slides',
  'application/vnd.google-apps.form': 'Google Forms',
  'application/vnd.google-apps.drawing': 'Google Drawings',
  'application/vnd.google-apps.folder': 'Folder',
  'application/pdf': 'PDF',
};

/** What kind of file, for people: "Google Sheets", "PDF", "Image", "File". */
export function driveKind(mimeType: string): string {
  const kind = KINDS[mimeType];
  if (kind) return kind;
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType.startsWith('video/')) return 'Video';
  if (mimeType.startsWith('audio/')) return 'Audio';
  return 'File';
}

/** A pointer as a block's attributes hold it, or null when they don't make one. */
export function driveFileOf(attrs: Record<string, unknown> | undefined): DriveFileRef | null {
  if (!attrs || !isDriveFileId(attrs.fileId)) return null;
  const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    fileId: attrs.fileId,
    name: typeof attrs.name === 'string' && attrs.name ? attrs.name : 'Untitled',
    mimeType: typeof attrs.mimeType === 'string' ? attrs.mimeType : '',
    modifiedAt: number(attrs.modifiedAt),
    size: number(attrs.size),
  };
}

/** A file as Drive's API describes it (`files.get` with these fields), or null. */
export const DRIVE_FIELDS = 'id,name,mimeType,modifiedTime,size,trashed';

export function driveFileFromApi(raw: unknown): (DriveFileRef & { trashed: boolean }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (!isDriveFileId(f.id) || typeof f.name !== 'string') return null;
  const modified = typeof f.modifiedTime === 'string' ? Date.parse(f.modifiedTime) : NaN;
  const size = typeof f.size === 'string' ? Number(f.size) : NaN;
  return {
    fileId: f.id,
    name: f.name,
    mimeType: typeof f.mimeType === 'string' ? f.mimeType : '',
    modifiedAt: Number.isFinite(modified) ? modified : null,
    size: Number.isFinite(size) ? size : null,
    trashed: f.trashed === true,
  };
}

// --- Signing in to Google (an installed app: the browser, then back to this computer) ----

/** Only the files people pick, and who they are. */
export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'];

/** The URL that asks someone to let the app in (authorization code with PKCE). */
export function googleAuthUrl(options: {
  authUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(options.authUrl);
  url.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    // A refresh token, so it stays connected.
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  return url.href;
}

/**
 * The email in an ID token (from Google's token endpoint, over TLS: read, not verified), or
 * null.
 */
export function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))),
    ) as { email?: unknown };
    return typeof json.email === 'string' ? json.email : null;
  } catch {
    return null;
  }
}
