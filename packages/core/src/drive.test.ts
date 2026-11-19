import { describe, expect, it } from 'vitest';
import {
  driveFileFromApi,
  driveFileOf,
  driveKind,
  driveOpenUrl,
  emailFromIdToken,
  googleAuthUrl,
} from './index';

const ID = '1AbC_def-GHIjkl23';

describe('Drive files', () => {
  it("a block's attributes as a pointer; nothing without a real id", () => {
    expect(driveFileOf({ fileId: ID, name: 'Gripper BOM', mimeType: 'x', size: 4 })).toEqual({
      fileId: ID,
      name: 'Gripper BOM',
      mimeType: 'x',
      modifiedAt: null,
      size: 4,
    });
    for (const fileId of ['', 'short', '../../etc', 'a b c d e f g h', null]) {
      expect(driveFileOf({ fileId }), String(fileId)).toBeNull();
    }
  });

  it('opens by its id, whatever the page says', () => {
    expect(driveOpenUrl(ID)).toBe(`https://drive.google.com/open?id=${ID}`);
  });

  it('kinds for people', () => {
    expect(driveKind('application/vnd.google-apps.spreadsheet')).toBe('Google Sheets');
    expect(driveKind('application/pdf')).toBe('PDF');
    expect(driveKind('image/png')).toBe('Image');
    expect(driveKind('model/step')).toBe('File');
  });

  it("Drive's description of a file", () => {
    expect(
      driveFileFromApi({
        id: ID,
        name: 'Arm.step',
        mimeType: 'model/step',
        modifiedTime: '2026-11-18T10:00:00.000Z',
        size: '2048',
      }),
    ).toEqual({
      fileId: ID,
      name: 'Arm.step',
      mimeType: 'model/step',
      modifiedAt: Date.UTC(2026, 10, 18, 10),
      size: 2048,
      trashed: false,
    });
    // A Google Doc has no size.
    expect(driveFileFromApi({ id: ID, name: 'Notes', trashed: true })).toMatchObject({
      size: null,
      modifiedAt: null,
      trashed: true,
    });
    expect(driveFileFromApi({ id: 'x', name: 'n' })).toBeNull();
    expect(driveFileFromApi('nope')).toBeNull();
  });
});

describe('signing in to Google', () => {
  it('asks for drive.file only, offline, with PKCE', () => {
    const url = new URL(
      googleAuthUrl({
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        clientId: 'client.apps.googleusercontent.com',
        redirectUri: 'http://127.0.0.1:5123/oauth',
        state: 'st',
        codeChallenge: 'ch',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client.apps.googleusercontent.com',
      redirect_uri: 'http://127.0.0.1:5123/oauth',
      response_type: 'code',
      scope: 'openid email https://www.googleapis.com/auth/drive.file',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    });
  });

  it('reads the email from an ID token', () => {
    const part = (o: object) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const token = `${part({ alg: 'RS256' })}.${part({ email: 'ada@lab.io', sub: '1' })}.sig`;
    expect(emailFromIdToken(token)).toBe('ada@lab.io');
    expect(emailFromIdToken('not.a-token')).toBeNull();
    expect(emailFromIdToken(undefined)).toBeNull();
  });
});
