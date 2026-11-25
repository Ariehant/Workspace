/**
 * The Google source against a fake Google Calendar (test/fake-google.ts): signing in, tokens
 * that expire, calendars, and syncing with sync tokens, `410`, series and rate limits.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, today } from '../src/shared/dates';
import type { GoogleAccount, GoogleCalendar } from '../src/shared/types';
import { instantAt } from '../src/shared/zones';
import { Cache } from '../src/main/cache';
import { GoogleApiError, GoogleClient, GoogleEngine } from '../src/main/google/client';
import { googleEndpoints, GoogleTokens, signIn, type GoogleClientConfig } from '../src/main/google/oauth';
import { GoogleCalendarSync } from '../src/main/google/sync';
import { SyncService } from '../src/main/sync';
import { googleEnv, startFakeGoogle, type FakeGoogle } from './fake-google';

let fake: FakeGoogle;
let config: GoogleClientConfig;
const ZONE = 'Asia/Kolkata';
const endpoints = () => googleEndpoints(googleEnv(fake));
/** The browser: follows Google's redirect back to the app's loopback server. */
const browser = async (url: string) => {
  await fetch(url);
};

beforeAll(async () => {
  fake = await startFakeGoogle();
  config = { clientId: fake.clientId, clientSecret: fake.clientSecret };
});
afterAll(() => fake?.close());

const d = (offset: number) => addDays(today(), offset);
/** A time on day `offset` at `hh:mm` in Kolkata, as Google writes it. */
const at = (offset: number, hhmm: string) => ({
  dateTime: instantAt(`${d(offset)}T${hhmm}`, ZONE).toISOString(),
  timeZone: ZONE,
});

async function signedIn() {
  const tokens = await signIn({ config, endpoints: endpoints(), open: browser });
  return new GoogleTokens({
    config: () => config,
    endpoints: endpoints(),
    refreshToken: tokens.refreshToken,
    initial: tokens,
  });
}

describe('signing in', () => {
  it('signs in through the browser with PKCE and names the account', async () => {
    const tokens = await signIn({ config, endpoints: endpoints(), open: browser });
    expect(tokens).toMatchObject({
      refreshToken: 'rt-1',
      email: 'ada@lab.io',
      accessToken: expect.stringMatching(/^at-/),
    });
  });

  it('says when the person said no', async () => {
    const error = await signIn({
      config,
      endpoints: endpoints(),
      open: async (url) => {
        const redirect = new URL(url).searchParams.get('redirect_uri')!;
        const state = new URL(url).searchParams.get('state')!;
        await fetch(`${redirect}?error=access_denied&state=${state}`);
      },
    }).catch((e: Error) => e);
    expect(error).toMatchObject({ message: 'Access wasn’t allowed.' });
  });

  it('refuses a client Google does not know', async () => {
    const error = await signIn({
      config: { ...config, clientSecret: 'wrong' },
      endpoints: endpoints(),
      open: browser,
    }).catch((e: Error) => e);
    expect(error).toMatchObject({ code: 'invalid_client' });
  });
});

describe('tokens', () => {
  it('refreshes the access token before it expires (an hour later)', async () => {
    let now = Date.now();
    const first = await signIn({ config, endpoints: endpoints(), open: browser });
    const tokens = new GoogleTokens({
      config: () => config,
      endpoints: endpoints(),
      refreshToken: first.refreshToken,
      initial: first,
      now: () => now,
    });
    expect(await tokens.accessToken()).toBe(first.accessToken);
    const grants = fake.grants.length;
    now += 3600_000;
    const next = await tokens.accessToken();
    expect(next).not.toBe(first.accessToken);
    expect(fake.grants.slice(grants)).toEqual(['refresh_token']);
    // Two requests at once share one refresh.
    now += 3600_000;
    const [a, b] = await Promise.all([tokens.accessToken(), tokens.accessToken()]);
    expect(a).toBe(b);
    expect(fake.grants.slice(grants)).toEqual(['refresh_token', 'refresh_token']);
  });

  it('refreshes once when Google refuses a token early (401)', async () => {
    const engine = new GoogleEngine(new GoogleClient({ tokens: await signedIn(), base: fake.origin }));
    fake.addCalendar({ id: 'tokens@lab.io', summary: 'Tokens', accessRole: 'owner', timeZone: ZONE });
    fake.expireTokens();
    expect((await engine.calendars()).map((c) => c.id)).toContain('tokens@lab.io');
  });
});

describe('calendars and events', () => {
  let cache: Cache;
  let engine: GoogleEngine;
  let sync: GoogleCalendarSync;
  let calendar: GoogleCalendar;
  let n = 0;
  const account: GoogleAccount = { id: 'gacc', kind: 'google', name: 'ada@lab.io', email: 'ada@lab.io', error: null };

  beforeEach(async () => {
    const googleId = `cal${++n}@lab.io`;
    fake.addCalendar({ id: googleId, summary: `Cal ${n}`, accessRole: 'owner', timeZone: ZONE, backgroundColor: '#9fe1e7' });
    cache = new Cache(':memory:');
    cache.addAccount(account, 'sealed');
    calendar = {
      id: `g-${n}`,
      kind: 'google',
      accountId: account.id,
      googleId,
      accessRole: 'owner',
      timeZone: ZONE,
      name: `Cal ${n}`,
      colour: '#9fe1e7',
      visible: true,
      status: 'ok',
      statusMessage: null,
    };
    cache.addCalendar(calendar);
    engine = new GoogleEngine(
      new GoogleClient({ tokens: await signedIn(), base: fake.origin, sleep: async () => {} }),
    );
    sync = new GoogleCalendarSync({ cache, engine, zone: () => ZONE });
  });

  const titles = () =>
    cache
      .eventsBetween(d(-200), d(400))
      .filter((e) => e.calendarId === calendar.id)
      .map((e) => `${e.title} ${e.start}`)
      .sort();

  it('lists the account\'s calendars with their colours and roles', async () => {
    const list = await engine.calendars();
    expect(list.find((c) => c.id === calendar.googleId)).toMatchObject({
      summary: calendar.name,
      accessRole: 'owner',
      backgroundColor: '#9fe1e7',
    });
  });

  it('reads everything first, then only changes with the sync token', async () => {
    fake.put(calendar.googleId, { id: 'review', summary: 'Review', start: at(2, '10:00'), end: at(2, '11:00') });
    fake.put(calendar.googleId, { id: 'trip', summary: 'Trip', start: { date: d(5) }, end: { date: d(8) } });
    fake.put(calendar.googleId, { id: 'old', summary: 'Old', start: { date: d(-400) }, end: { date: d(-399) } });
    await sync.sync(calendar, false);
    expect(titles()).toEqual([`Review ${d(2)}T10:00`, `Trip ${d(5)}`]);
    expect(cache.event(`${calendar.id}:trip`)).toMatchObject({ end: d(7) });
    expect(cache.cursor(calendar.id)).toEqual(expect.any(String));
    expect(fake.requests.at(-1)).toContain('timeMin=');

    fake.put(calendar.googleId, { id: 'review', summary: 'Review (moved)', start: at(3, '15:30'), end: at(3, '16:00') });
    fake.remove(calendar.googleId, 'trip');
    fake.put(calendar.googleId, { id: 'new', summary: 'New', start: at(1, '09:00'), end: at(1, '09:30') });
    await sync.sync(calendar, false);
    expect(fake.requests.at(-1)).toContain('syncToken=');
    expect(titles()).toEqual([`New ${d(1)}T09:00`, `Review (moved) ${d(3)}T15:30`]);
  });

  it('reads every page', async () => {
    fake.pageSize = 2;
    try {
      for (let i = 0; i < 5; i++)
        fake.put(calendar.googleId, { id: `p${i}`, summary: `P${i}`, start: { date: d(i) }, end: { date: d(i + 1) } });
      await sync.sync(calendar, false);
      expect(titles()).toHaveLength(5);
    } finally {
      fake.pageSize = 2500;
    }
  });

  it('syncs from scratch when Google no longer takes the sync token (410)', async () => {
    fake.put(calendar.googleId, { id: 'a', summary: 'A', start: { date: d(1) }, end: { date: d(2) } });
    await sync.sync(calendar, false);
    fake.invalidateSyncTokens();
    fake.put(calendar.googleId, { id: 'b', summary: 'B', start: { date: d(1) }, end: { date: d(2) } });
    await sync.sync(calendar, false);
    expect(fake.requests.slice(-2).map((r) => (r.includes('syncToken=') ? 'token' : 'full'))).toEqual([
      'token',
      'full',
    ]);
    expect(titles()).toEqual([`A ${d(1)}`, `B ${d(1)}`]);
  });

  it('expands series, with changed and cancelled occurrences, and follows their changes', async () => {
    fake.put(calendar.googleId, {
      id: 'standup',
      summary: 'Standup',
      start: at(1, '09:00'),
      end: at(1, '09:15'),
      recurrence: ['RRULE:FREQ=DAILY;COUNT=3'],
    });
    await sync.sync(calendar, false);
    expect(titles()).toEqual([1, 2, 3].map((i) => `Standup ${d(i)}T09:00`));

    const second = instantAt(`${d(2)}T09:00`, ZONE);
    fake.put(calendar.googleId, {
      id: `standup_${second.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
      recurringEventId: 'standup',
      originalStartTime: at(2, '09:00'),
      summary: 'Standup (late)',
      start: at(2, '11:00'),
      end: at(2, '11:15'),
    });
    fake.put(calendar.googleId, {
      id: 'standup_x3',
      recurringEventId: 'standup',
      originalStartTime: at(3, '09:00'),
      status: 'cancelled',
    });
    await sync.sync(calendar, false);
    expect(titles()).toEqual([`Standup (late) ${d(2)}T11:00`, `Standup ${d(1)}T09:00`]);

    // The series is deleted: its occurrences go with it.
    fake.remove(calendar.googleId, 'standup');
    await sync.sync(calendar, false);
    expect(titles()).toEqual([]);
  });

  it('waits through rate limits and server errors', async () => {
    fake.put(calendar.googleId, { id: 'a', summary: 'A', start: { date: d(1) }, end: { date: d(2) } });
    fake.failures.push(
      { status: 429, retryAfter: '0' },
      { status: 403, reason: 'rateLimitExceeded' },
      { status: 503 },
    );
    await sync.sync(calendar, false);
    expect(titles()).toEqual([`A ${d(1)}`]);
  });

  it('works the events out again when the time zone changes', async () => {
    let zone = ZONE;
    const zoned = new GoogleCalendarSync({ cache, engine, zone: () => zone });
    fake.put(calendar.googleId, { id: 'call', summary: 'Call', start: at(2, '10:00'), end: at(2, '11:00') });
    await zoned.sync(calendar, false);
    expect(titles()).toEqual([`Call ${d(2)}T10:00`]);
    zone = 'Europe/London';
    await zoned.sync(calendar, false);
    expect(titles()).toEqual([expect.stringMatching(new RegExp(`^Call ${d(2)}T0[45]:30$`))]);
  });

  it('marks a calendar the account can no longer see, and an account signed out', async () => {
    fake.calendars.delete(calendar.googleId);
    const notFound = await sync.sync(calendar, false).catch((e: unknown) => e);
    expect(sync.problem(notFound, calendar)).toMatchObject({ kind: 'calendar', status: 'no-access' });

    const revoked = new GoogleEngine(
      new GoogleClient({
        tokens: new GoogleTokens({ config: () => config, endpoints: endpoints(), refreshToken: 'rt-gone' }),
        base: fake.origin,
      }),
    );
    const error = await revoked.calendars().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(sync.problem(error, calendar)).toMatchObject({ kind: 'account' });
  });

  it('runs inside the sync service, beside Workspace calendars', async () => {
    fake.put(calendar.googleId, { id: 'a', summary: 'A', start: { date: d(1) }, end: { date: d(2) } });
    const service = new SyncService({
      cache,
      engineFor: () => null,
      googleFor: () => sync,
    });
    await service.syncAll();
    expect(titles()).toEqual([`A ${d(1)}`]);
    expect(service.status).toMatchObject({ online: true, error: null });

    const signedOut = new SyncService({ cache, engineFor: () => null, googleFor: () => null });
    await signedOut.syncAll();
    expect(cache.account(account.id)?.error).toMatch(/sign in again/);
  });
});
