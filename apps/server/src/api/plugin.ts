/**
 * The public API (Phase 6 M5), Notion's, at `/v1/…`, for integrations.
 *
 * - **Auth:** `Authorization: Bearer ntn_…`, an integration's token (looked up by its
 *   hash). Session cookies mean nothing here, and API tokens nothing on `/api/…` (they
 *   aren't sessions), so neither can stand in for the other.
 * - **Versions:** `Notion-Version` is required; from 2025-09-03 databases have data sources.
 * - **Notion's conventions:** errors as `{object: "error", status, code, message}`,
 *   500 KB per request, and a rate limit per integration (3 requests a second on
 *   average, in bursts), with `Retry-After`.
 */
import { ApiError, parseVersion, type ApiVersion } from '@workspace/api-model';
import type { Integration } from '@workspace/storage-remote';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context';
import { ApiView } from './view';
import { databaseRoutes } from './databases';
import { pageRoutes } from './pages';
import { searchRoutes } from './search';
import { userRoutes } from './users';

export interface ApiOptions {
  /** Requests a second, on average, per integration. */
  perSecond?: number;
  /** How many may come at once. */
  burst?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    api: ApiView | null;
  }
}

const MAX_BODY = 500 * 1024;

/** A token bucket per integration. */
class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
  ) {}

  /** Seconds to wait (0: go ahead). */
  take(key: string, now = Date.now()): number {
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.perSecond);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / this.perSecond);
  }
}

const send = (reply: FastifyReply, error: ApiError) =>
  reply.code(error.status).send(error.toJSON());

const bearer = (request: FastifyRequest) =>
  /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1] ?? null;

export function apiRoutes(app: FastifyInstance, ctx: ServerContext, options: ApiOptions = {}) {
  const limiter = new RateLimiter(options.perSecond ?? 3, options.burst ?? 30);
  app.decorateRequest('api', null);

  void app.register(
    async (v1) => {
      v1.addHook('onRoute', (route) => {
        route.bodyLimit ??= MAX_BODY;
      });

      v1.addHook('onRequest', async (request, reply) => {
        const token = bearer(request);
        const integration: Integration | null = token
          ? await ctx.store.integrations.byToken(token)
          : null;
        if (!integration) {
          return send(reply, new ApiError('unauthorized', 'API token is invalid.'));
        }
        const wait = limiter.take(integration.id);
        if (wait > 0) {
          reply.header('retry-after', String(wait));
          return send(
            reply,
            new ApiError(
              'rate_limited',
              'You have been rate limited. Please try again in a few seconds.',
            ),
          );
        }
        const header = request.headers['notion-version'];
        if (header === undefined) {
          return send(
            reply,
            new ApiError(
              'missing_version',
              'Notion-Version header failed validation: it is missing.',
            ),
          );
        }
        const version: ApiVersion | null = parseVersion(header);
        if (!version) {
          return send(
            reply,
            new ApiError(
              'invalid_request',
              `Notion-Version header failed validation: "${String(header)}" isn't a version.`,
            ),
          );
        }
        const access = await ctx.access.workspace(integration.workspaceId);
        if (!access.isBot(integration.id)) {
          return send(reply, new ApiError('unauthorized', 'API token is invalid.'));
        }
        request.api = new ApiView(ctx, integration, version, access);
      });

      v1.setErrorHandler((error, _request, reply) => {
        if (error instanceof ApiError) return send(reply, error);
        const e = error as {
          statusCode?: number;
          code?: string;
          validation?: unknown;
          message: string;
        };
        if (e.validation)
          return send(
            reply,
            new ApiError('validation_error', `body failed validation: ${e.message}`),
          );
        if (
          (e.code?.startsWith('FST_ERR_CTP') && e.code.includes('JSON')) ||
          error instanceof SyntaxError
        ) {
          return send(reply, new ApiError('invalid_json', 'Error parsing JSON body.'));
        }
        if (e.statusCode === 413) {
          return reply.code(413).send({
            object: 'error',
            status: 413,
            code: 'validation_error',
            message: `Request body too large (the limit is ${MAX_BODY / 1024} KB).`,
          });
        }
        if (e.statusCode === 415) {
          return send(
            reply,
            new ApiError('invalid_request', 'Content-Type should be application/json.'),
          );
        }
        if (e.statusCode && e.statusCode < 500) {
          return send(reply, new ApiError('invalid_request', e.message));
        }
        reply.log.error(error);
        return send(reply, new ApiError('internal_server_error', 'Unexpected error occurred.'));
      });

      v1.setNotFoundHandler((request, reply) =>
        send(
          reply,
          new ApiError(
            'invalid_request_url',
            `Invalid request URL: ${request.method} ${request.url}`,
          ),
        ),
      );

      userRoutes(v1);
      pageRoutes(v1);
      databaseRoutes(v1);
      searchRoutes(v1);
    },
    { prefix: '/v1' },
  );
}

/** The request's API view (the auth hook set it). */
export const viewOf = (request: FastifyRequest): ApiView => request.api!;
