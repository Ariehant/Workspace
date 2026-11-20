/**
 * The workspace's people, through the host's `TeamPlatform`: members and their roles,
 * invites, groups, and the signed-in account's profile.
 */
import type { WorkspaceRole } from '@workspace/core';
import { useMemo } from 'react';
import type { AutomationRun, Platform, SyncInfo, TeamPlatform } from './platform';

export interface MemberInfo {
  id: string;
  name: string;
  email: string;
  avatar: string | null;
  role: WorkspaceRole;
  joinedAt: string;
  disabled: boolean;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: InviteRole;
  createdAt: string;
  expiresAt: string;
}

export type InviteRole = Exclude<WorkspaceRole, 'owner'>;

export type ScopeRole = 'full' | 'edit' | 'content' | 'create' | 'comment' | 'view';
export type ScopeVisibility = 'open' | 'closed' | 'private';

/** Who gets what in a scope: `user:<id>`, `group:<id>` or `workspace` (every member). */
export interface AccessEntry {
  principal: string;
  role: ScopeRole;
}

/** A scope as the server describes it (to someone with a role in it). */
export interface ScopeDetails {
  id: string;
  kind: 'teamspace' | 'private' | 'shared';
  name: string;
  treeDoc: string;
  parentId: string | null;
  inherit: boolean;
  icon: string | null;
  description: string;
  visibility: ScopeVisibility;
  joinRole: ScopeRole;
  role: ScopeRole;
  /** Who has access (not shown to guests, except where they have full access). */
  access?: AccessEntry[];
}

/** A teamspace the person can find (joined or not). */
export interface TeamspaceListing extends Omit<ScopeDetails, 'role' | 'access'> {
  /** Theirs, or `null` if they haven't joined. */
  role: ScopeRole | null;
  /** People added to it by name. */
  members: number;
  /** What everyone in the workspace gets, if anything. */
  everyone: ScopeRole | null;
}

export const SCOPE_ROLE_LABELS: Record<ScopeRole, string> = {
  full: 'Full access',
  edit: 'Can edit',
  content: 'Can edit content',
  create: 'Can create pages',
  comment: 'Can comment',
  view: 'Can view',
};

export const SCOPE_ROLE_HINTS: Record<ScopeRole, string> = {
  full: 'Edit and share with others',
  edit: 'Edit, but not share',
  content: 'Edit rows, not properties or views',
  create: 'Add pages, and edit only their own',
  comment: 'View and comment',
  view: 'View only',
};

export type ShareLinkRole = 'view' | 'comment' | 'edit';

/** A page's share link, as its sharers see it. */
export interface ShareLinkInfo {
  url: string;
  role: ShareLinkRole;
  /** When it stops working (ms), or null. */
  expiresAt: number | null;
  createdAt: number;
}

export interface CreatedInvite {
  id: string;
  email: string;
  role: InviteRole;
  /** The link to send (shown once). */
  link: string;
  /** The server emailed it. */
  emailed: boolean;
}

export interface GroupInfo {
  id: string;
  name: string;
  members: string[];
}

export interface Profile {
  id: string;
  name: string;
  email: string;
  avatar: string | null;
}

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
};

export const ROLE_HINTS: Record<WorkspaceRole, string> = {
  owner: 'Everything, including who owns the workspace',
  admin: 'Manages members, groups and settings',
  member: 'Sees and edits the workspace’s shared pages',
  guest: 'Only sees pages shared with them',
};

/** Split pasted addresses ("a@x.io, b@x.io\nc@x.io"). */
export function parseEmails(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((e) => e.trim().replace(/^<|>$/g, ''))
        .filter((e) => /^[^\s@]+@[^\s@]+$/.test(e))
        .map((e) => e.toLowerCase()),
    ),
  ];
}

export function teamApi(team: TeamPlatform) {
  const r = team.request.bind(team);
  return {
    members: () => r<{ role: WorkspaceRole; members: MemberInfo[] }>('GET', 'members'),
    setRole: (userId: string, role: WorkspaceRole) =>
      r<{ ok: true }>('PATCH', `members/${userId}`, { role }),
    /** Remove someone, or leave (your own id). */
    remove: (userId: string) => r<{ ok: true }>('DELETE', `members/${userId}`),
    invites: () => r<{ invites: PendingInvite[] }>('GET', 'invites'),
    invite: (emails: string[], role: InviteRole) =>
      r<{ invites: CreatedInvite[]; skipped: string[] }>('POST', 'invites', { emails, role }),
    revokeInvite: (id: string) => r<{ ok: true }>('DELETE', `invites/${id}`),
    groups: () => r<{ groups: GroupInfo[] }>('GET', 'groups'),
    createGroup: (name: string) => r<{ group: GroupInfo }>('POST', 'groups', { name }),
    renameGroup: (id: string, name: string) => r<{ ok: true }>('PATCH', `groups/${id}`, { name }),
    deleteGroup: (id: string) => r<{ ok: true }>('DELETE', `groups/${id}`),
    addToGroup: (id: string, userId: string) =>
      r<{ ok: true }>('PUT', `groups/${id}/members/${userId}`),
    removeFromGroup: (id: string, userId: string) =>
      r<{ ok: true }>('DELETE', `groups/${id}/members/${userId}`),
    // Scopes: teamspaces, sharing, moving pages between them.
    scopes: () => r<{ defaultScopeId: string | null; scopes: ScopeDetails[] }>('GET', 'scopes'),
    teamspaces: () => r<{ teamspaces: TeamspaceListing[] }>('GET', 'teamspaces'),
    createTeamspace: (input: {
      name: string;
      icon?: string | null;
      description?: string;
      visibility?: ScopeVisibility;
      joinRole?: ScopeRole;
      everyone?: ScopeRole | null;
    }) => r<{ scope: ScopeDetails }>('POST', 'teamspaces', input),
    updateScope: (
      id: string,
      change: Partial<
        Pick<ScopeDetails, 'name' | 'inherit' | 'icon' | 'description' | 'visibility' | 'joinRole'>
      >,
    ) => r<{ ok: true }>('PATCH', `scopes/${id}`, change),
    setAccess: (id: string, principal: string, role: ScopeRole | null) =>
      r<{ ok: true }>('PUT', `scopes/${id}/access`, { principal, role }),
    joinTeamspace: (id: string) => r<{ ok: true }>('POST', `scopes/${id}/join`),
    leaveTeamspace: (id: string) => r<{ ok: true }>('POST', `scopes/${id}/leave`),
    /** Make a page its own scope (to share it), from scope `from` where it is now. */
    sharePage: (pageId: string, from: string) =>
      r<{ scope: ScopeDetails }>('POST', `pages/${pageId}/share`, { scope: from }),
    movePage: (pageId: string, from: string, to: string, parentId: string | null) =>
      r<{ ok: true }>('POST', `pages/${pageId}/move`, { from, to, parentId }),
    // Requests for access (Phase 8 N4): asking for a page you can't open, and answering.
    pageAccess: (pageId: string) => r<PageAccess>('GET', `pages/${pageId}/access`),
    requestAccess: (pageId: string, role: RequestedRole, message: string) =>
      r<{ request: OwnAccessRequest }>('POST', `pages/${pageId}/access-requests`, {
        role,
        message,
      }),
    accessRequests: (pageId?: string) =>
      r<{ requests: AccessRequestInfo[] }>(
        'GET',
        pageId ? `access-requests?pageId=${encodeURIComponent(pageId)}` : 'access-requests',
      ),
    accessRequest: (id: string) =>
      r<{ request: AccessRequestInfo }>('GET', `access-requests/${id}`),
    approveRequest: (id: string, role: RequestedRole) =>
      r<{ request: AccessRequestInfo }>('POST', `access-requests/${id}/approve`, { role }),
    declineRequest: (id: string) =>
      r<{ request: AccessRequestInfo }>('POST', `access-requests/${id}/decline`),
    me: async () => (await r<{ user: Profile }>('GET', 'me')).user,
    updateMe: async (change: { name?: string; avatar?: string | null }) =>
      (await r<{ user: Profile }>('PATCH', 'me', change)).user,
    /** Emails about unread notifications (Phase 6 M7), and whether the server sends any. */
    emailSettings: () => r<EmailSettings>('GET', 'me/email'),
    setEmailDigest: (digest: EmailDigest) => r<EmailSettings>('PUT', 'me/email', { digest }),
    // Moving a page to another workspace (Phase 8 #31): into your private pages there.
    moveTargets: async () =>
      (await r<{ workspaces: { id: string; name: string }[] }>('GET', 'move-targets')).workspaces,
    moveToWorkspace: (pageId: string, to: string) =>
      r<{ workspaceId: string; pageId: string }>(
        'POST',
        `pages/${encodeURIComponent(pageId)}/move-to-workspace`,
        { to },
      ),
    // Share links (Phase 8 N8): open to whoever signs in with the link.
    shareLink: (pageId: string) => r<{ link: ShareLinkInfo | null }>('GET', `pages/${pageId}/link`),
    makeShareLink: (pageId: string, role: ShareLinkRole, days: number | null) =>
      r<{ link: ShareLinkInfo }>('PUT', `pages/${pageId}/link`, { role, days }),
    removeShareLink: (pageId: string) => r<{ ok: true }>('DELETE', `pages/${pageId}/link`),
    // Publishing (Phase 5 M7).
    published: (pageId: string) =>
      r<{ published: PublishedPage | null; suggestedSlug: string }>(
        'GET',
        `pages/${pageId}/publish`,
      ),
    publish: (pageId: string, settings: PublishSettings) =>
      r<{ published: PublishedPage }>('PUT', `pages/${pageId}/publish`, settings),
    unpublish: (pageId: string) => r<{ published: null }>('DELETE', `pages/${pageId}/publish`),
    // Views (people who opened it, and public visitors).
    analytics: (pageId: string) =>
      r<{ views: number; viewers: number; days: { day: string; views: number }[] }>(
        'GET',
        `pages/${pageId}/analytics`,
      ),
    view: (pageId: string) => r<{ ok: true }>('POST', `pages/${pageId}/views`),
    // Forms (Phase 6 M2): responses, written by the server; public links.
    submitForm: (databaseId: string, viewId: string, answers: Record<string, unknown>) =>
      r<{ rowId: string }>('POST', `forms/${databaseId}/${viewId}/submit`, { answers }),
    formLink: (databaseId: string, viewId: string) =>
      r<{ link: string | null }>('GET', `forms/${databaseId}/${viewId}/link`),
    newFormLink: (databaseId: string, viewId: string) =>
      r<{ link: string | null }>('PUT', `forms/${databaseId}/${viewId}/link`),
    removeFormLink: (databaseId: string, viewId: string) =>
      r<{ link: string | null }>('DELETE', `forms/${databaseId}/${viewId}/link`),
    // Automations (Phase 6 M3): recent runs, and the webhook signing secret.
    automationRuns: (databaseId: string, automationId: string) =>
      r<{ runs: AutomationRun[] }>('GET', `automations/${databaseId}/${automationId}/runs`),
    automationSecret: (databaseId: string, automationId: string) =>
      r<{ secret: string }>('GET', `automations/${databaseId}/${automationId}/secret`),
    // A button's webhook and notification steps (Phase 6 M4), as the person who pressed it.
    buttonWebhook: (request: {
      docId: string;
      pageId: string | null;
      url: string;
      headers: Record<string, string>;
      data: unknown;
      label: string;
    }) => r<{ queued: boolean }>('POST', 'buttons/webhook', request),
    buttonNotify: (request: {
      docId: string;
      pageId: string | null;
      people: string[];
      message: string;
      label: string;
    }) => r<{ sent: number }>('POST', 'buttons/notify', request),
    buttonSecret: () => r<{ secret: string }>('GET', 'buttons/secret'),
    // Integrations (Phase 6 M5): settings (owners and admins), and the list (members).
    integrations: () => r<{ integrations: IntegrationInfo[] }>('GET', 'integrations'),
    createIntegration: (body: { name: string; icon?: string | null }) =>
      r<{ integration: IntegrationInfo; token: string }>('POST', 'integrations', body),
    updateIntegration: (
      id: string,
      body: {
        name?: string;
        icon?: string | null;
        capabilities?: Partial<IntegrationCapabilities>;
      },
    ) => r<{ integration: IntegrationInfo }>('PATCH', `integrations/${id}`, body),
    rotateIntegrationToken: (id: string) =>
      r<{ token: string }>('POST', `integrations/${id}/token`),
    deleteIntegration: (id: string) => r<{ ok: true }>('DELETE', `integrations/${id}`),
    // Its webhook (Phase 6 M7): a new URL is sent a token, pasted back to verify it.
    setWebhook: (id: string, body: { url: string; events: string[] }) =>
      r<{ webhook: IntegrationWebhook }>('PUT', `integrations/${id}/webhook`, body),
    verifyWebhook: (id: string, token: string) =>
      r<{ webhook: IntegrationWebhook }>('POST', `integrations/${id}/webhook/verify`, { token }),
    resendWebhookToken: (id: string) =>
      r<{ ok: true }>('POST', `integrations/${id}/webhook/resend`),
    resumeWebhook: (id: string) =>
      r<{ webhook: IntegrationWebhook }>('POST', `integrations/${id}/webhook/resume`),
    removeWebhook: (id: string) => r<{ ok: true }>('DELETE', `integrations/${id}/webhook`),
  };
}

/** What may be asked for: the rest is for the people who share to decide. */
export type RequestedRole = 'view' | 'comment' | 'edit';
export const REQUESTED_ROLES: readonly RequestedRole[] = ['view', 'comment', 'edit'];

/** Your own request, as you see it. */
export interface OwnAccessRequest {
  id: string;
  role: RequestedRole;
  status: 'pending' | 'approved' | 'declined';
  createdAt: number;
  decidedAt: number | null;
}

/** A request, as the people who can share the page see it. */
export interface AccessRequestInfo extends OwnAccessRequest {
  pageId: string;
  requesterId: string;
  message: string;
  decidedBy: string | null;
}

/** Whether you can open a page (and, if not, whether you asked). */
export type PageAccess =
  | { exists: false }
  | { exists: true; readable: true }
  | { exists: true; readable: false; request: OwnAccessRequest | null };

export interface PublishSettings {
  slug: string;
  includeSubpages: boolean;
  allowIndexing: boolean;
  title: string;
  description: string;
}

/** A page on the web, at `url`. */
export interface PublishedPage extends PublishSettings {
  pageId: string;
  url: string;
  publishedAt: number;
}

/** What an integration may do through the API. */
export interface IntegrationCapabilities {
  readContent: boolean;
  updateContent: boolean;
  insertContent: boolean;
  readComments: boolean;
  insertComments: boolean;
  userInfo: 'none' | 'noEmail' | 'email';
}

/** An integration (its settings only for owners and admins). */
export interface IntegrationInfo {
  /** Its bot's id (shared with as `user:<id>`). */
  id: string;
  name: string;
  icon: string | null;
  capabilities?: IntegrationCapabilities;
  createdAt?: number;
  /** The token's last characters. */
  tokenHint?: string | null;
  lastUsedAt?: number | null;
  /** Its webhook subscription (owners and admins). */
  webhook?: IntegrationWebhook | null;
}

/** An integration's webhook subscription, as settings show it. */
export interface IntegrationWebhook {
  url: string;
  events: string[];
  verified: boolean;
  paused: boolean;
  failingSince: number | null;
  lastError: string | null;
}

/** The events a webhook may ask for (Notion's), by group. */
export const WEBHOOK_EVENT_GROUPS: [string, string[]][] = [
  [
    'Pages',
    [
      'page.created',
      'page.properties_updated',
      'page.content_updated',
      'page.moved',
      'page.deleted',
      'page.undeleted',
      'page.locked',
      'page.unlocked',
    ],
  ],
  ['Databases', ['database.created', 'database.schema_updated', 'database.deleted']],
  ['Comments', ['comment.created', 'comment.updated', 'comment.deleted']],
];

/** When to email about unread notifications. */
export type EmailDigest = 'mentions' | 'daily' | 'never';

export interface EmailSettings {
  digest: EmailDigest;
  /** False when the server has no mail server set up. */
  available: boolean;
}

export type TeamApi = ReturnType<typeof teamApi>;

/**
 * The team API when there's a server to ask: always on the web, on the desktop while it
 * syncs this workspace.
 */
export function useTeam(platform: Platform, sync: SyncInfo | null): TeamApi | null {
  const available = !!platform.team && (!platform.sync || sync?.mode === 'on');
  const { team } = platform;
  return useMemo(() => (available && team ? teamApi(team) : null), [available, team]);
}

/** Shrink a picture to a square `size` px avatar, as a small `data:` URL. */
export async function avatarFromFile(file: Blob, size = 96): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  // The middle square of the picture.
  g.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size,
  );
  bitmap.close();
  const webp = canvas.toDataURL('image/webp', 0.85);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}
