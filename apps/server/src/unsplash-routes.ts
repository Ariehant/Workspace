/**
 * The cover gallery's Unsplash tab, when the server has an Unsplash access key: searches
 * go through here (the key never reaches browsers), and a picked photo's download is
 * reported, as Unsplash's API guidelines ask. Images are shown from Unsplash (hotlinked),
 * credited on the cover.
 */
import type { FastifyInstance } from 'fastify';
import { fail, requireUser } from './auth/context';
import type { ServerContext } from './context';

interface UnsplashResult {
  id: string;
  description: string | null;
  alt_description: string | null;
  urls: { small: string; regular: string; raw: string };
  user: { name: string; links: { html: string } };
  links: { download_location: string };
}

/** Unsplash asks for these on links back to it. */
const UTM = 'utm_source=workspace&utm_medium=referral';
const withUtm = (url: string) => `${url}${url.includes('?') ? '&' : '?'}${UTM}`;
const TIMEOUT_MS = 10_000;

export function unsplashRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);
  const unsplash = ctx.config.unsplash;

  const call = async (url: string) => {
    const response = await fetch(url, {
      headers: { authorization: `Client-ID ${unsplash!.accessKey}`, 'accept-version': 'v1' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Unsplash answered ${response.status}`);
    return response;
  };

  app.get<{ Querystring: { query: string; page?: number } }>(
    '/api/unsplash/photos',
    {
      preHandler: signedIn,
      // Unsplash allows a key 50 searches an hour until it's approved for production.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        querystring: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 100 },
            page: { type: 'integer', minimum: 1, maximum: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!unsplash) return fail(reply, 404, 'not_found', 'Unsplash isn’t set up on this server.');
      const params = new URLSearchParams({
        query: request.query.query,
        page: String(request.query.page ?? 1),
        per_page: '24',
        orientation: 'landscape',
        content_filter: 'high',
      });
      let results: UnsplashResult[];
      try {
        const body = (await (await call(`${unsplash.apiUrl}/search/photos?${params}`)).json()) as {
          results?: UnsplashResult[];
        };
        results = body.results ?? [];
      } catch (error) {
        request.log.warn({ err: error }, 'Unsplash search failed');
        return fail(reply, 502, 'unsplash_failed', 'Unsplash couldn’t be reached. Try again.');
      }
      return {
        photos: results.map((r) => ({
          id: r.id,
          description: r.description ?? r.alt_description ?? null,
          thumb: r.urls.small,
          // Wide enough for a cover, not the original's size.
          full: `${r.urls.raw}${r.urls.raw.includes('?') ? '&' : '?'}w=2400&q=80&fm=jpg&fit=crop`,
          author: r.user.name,
          authorUrl: withUtm(r.user.links.html),
          downloadLocation: r.links.download_location,
        })),
      };
    },
  );

  // A photo became a cover: Unsplash counts it as a download.
  app.post<{ Body: { downloadLocation: string } }>(
    '/api/unsplash/picked',
    {
      preHandler: signedIn,
      schema: {
        body: {
          type: 'object',
          required: ['downloadLocation'],
          properties: { downloadLocation: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (request, reply) => {
      if (!unsplash) return fail(reply, 404, 'not_found', 'Unsplash isn’t set up on this server.');
      // Only Unsplash's own addresses (the key goes with the request).
      let url: URL;
      try {
        url = new URL(request.body.downloadLocation);
      } catch {
        return fail(reply, 400, 'invalid', 'Not an Unsplash download address.');
      }
      if (url.origin !== new URL(unsplash.apiUrl).origin || !url.pathname.startsWith('/photos/')) {
        return fail(reply, 400, 'invalid', 'Not an Unsplash download address.');
      }
      try {
        await call(url.toString());
      } catch (error) {
        request.log.warn({ err: error }, 'Unsplash download report failed');
      }
      return { ok: true };
    },
  );
}
