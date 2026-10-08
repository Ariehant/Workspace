/**
 * The workspace's people, through the host's `TeamPlatform`: members and their roles,
 * invites, groups, and the signed-in account's profile.
 */
import type { WorkspaceRole } from '@workspace/core';
import { useMemo } from 'react';
import type { Platform, SyncInfo, TeamPlatform } from './platform';

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
    me: async () => (await r<{ user: Profile }>('GET', 'me')).user,
    updateMe: async (change: { name?: string; avatar?: string | null }) =>
      (await r<{ user: Profile }>('PATCH', 'me', change)).user,
  };
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
