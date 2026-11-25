/**
 * A stand-in for servers that publish iCalendar feeds (tests and E2E): feeds by path, with
 * ETags and Last-Modified (a request with a matching `If-None-Match` gets a `304`), redirects,
 * errors, and a record of what was asked.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeFeeds {
  origin: string;
  /** Feeds by path (`/holidays.ics`); change one to "publish" a new version. */
  feeds: Map<string, string>;
  /** Paths answered with a redirect to another path. */
  redirects: Map<string, string>;
  /** Paths answered with this status instead. */
  failures: Map<string, number>;
  /** Requests: path, and whether they asked only for changes. */
  requests: { path: string; conditional: boolean; status: number }[];
  close(): Promise<void>;
}

const etagOf = (body: string) => `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;

export async function startFakeFeeds(): Promise<FakeFeeds> {
  const fake = {
    feeds: new Map<string, string>(),
    redirects: new Map<string, string>(),
    failures: new Map<string, number>(),
    requests: [] as FakeFeeds['requests'],
  };
  const modified = new Map<string, string>();
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fake').pathname;
    const conditional = !!req.headers['if-none-match'] || !!req.headers['if-modified-since'];
    const answer = (status: number, headers: Record<string, string> = {}, body?: string) => {
      fake.requests.push({ path, conditional, status });
      res.writeHead(status, headers);
      res.end(body);
    };
    const failure = fake.failures.get(path);
    if (failure) return answer(failure, { 'content-type': 'text/plain' }, 'nope');
    const target = fake.redirects.get(path);
    if (target) return answer(302, { location: target });
    const body = fake.feeds.get(path);
    if (body === undefined) return answer(404, { 'content-type': 'text/plain' }, 'Not found');
    const etag = etagOf(body);
    if (!modified.has(`${path}${etag}`)) modified.set(`${path}${etag}`, new Date().toUTCString());
    if (req.headers['if-none-match'] === etag) return answer(304, { etag });
    answer(
      200,
      {
        'content-type': 'text/calendar; charset=utf-8',
        etag,
        'last-modified': modified.get(`${path}${etag}`)!,
      },
      body,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return Object.assign(fake, {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}

/** A one-event feed (for tests that only need something to show). */
export function feedWith(
  events: { uid: string; summary: string; start: string; end?: string }[],
  name = 'Test feed',
): string {
  const time = (t: string) =>
    t.length === 10 ? `;VALUE=DATE:${t.replace(/-/g, '')}` : `:${t.replace(/[-:]/g, '')}00`;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Workspace Calendar tests//EN',
    `X-WR-CALNAME:${name}`,
    ...events.flatMap((e) => [
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `SUMMARY:${e.summary}`,
      `DTSTART${time(e.start)}`,
      ...(e.end ? [`DTEND${time(e.end)}`] : []),
      'DTSTAMP:20261101T000000Z',
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}
