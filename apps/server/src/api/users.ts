/**
 * `GET /v1/users`, `GET /v1/users/:id` and `GET /v1/users/me` (the bot itself).
 * People need the "user information" capability; their emails, the "with emails" one.
 */
import {
  ApiError,
  botObject,
  listObject,
  notFound,
  parseId,
  parsePaging,
  personObject,
} from '@workspace/api-model';
import type { FastifyInstance } from 'fastify';
import { viewOf } from './plugin';
import type { ApiView } from './view';

async function everyone(api: ApiView) {
  const { store } = api.ctx;
  const workspace = await store.getWorkspace(api.workspaceId);
  const withEmail = api.integration.capabilities.userInfo === 'email';
  const people = (await store.teams.members(api.workspaceId))
    .filter((m) => !m.disabled)
    .map((m) => ({
      id: m.userId,
      json: personObject(
        { id: m.userId, name: m.name, avatar: m.avatar, email: m.email },
        withEmail,
      ),
    }));
  const bots = (await store.integrations.list(api.workspaceId)).map((b) => ({
    id: b.id,
    json: botObject(b, workspace?.name ?? ''),
  }));
  return [...people, ...bots];
}

function needUserInfo(api: ApiView) {
  if (api.integration.capabilities.userInfo === 'none') {
    throw new ApiError(
      'restricted_resource',
      'Insufficient permissions for this endpoint: the integration may not read user information.',
    );
  }
}

export function userRoutes(app: FastifyInstance) {
  app.get('/users/me', async (request) => {
    const api = viewOf(request);
    const workspace = await api.ctx.store.getWorkspace(api.workspaceId);
    return botObject(api.integration, workspace?.name ?? '');
  });

  app.get<{ Querystring: Record<string, unknown> }>('/users', async (request) => {
    const api = viewOf(request);
    needUserInfo(api);
    const list = await everyone(api);
    return listObject(
      list,
      (u) => u.id,
      parsePaging(request.query),
      'user',
      (u) => u.json,
    );
  });

  app.get<{ Params: { id: string } }>('/users/:id', async (request) => {
    const api = viewOf(request);
    const id = parseId(request.params.id);
    if (id === api.botId) {
      const workspace = await api.ctx.store.getWorkspace(api.workspaceId);
      return botObject(api.integration, workspace?.name ?? '');
    }
    needUserInfo(api);
    const found = id ? (await everyone(api)).find((u) => u.id === id) : undefined;
    if (!found) throw notFound(request.params.id);
    return found.json;
  });
}
