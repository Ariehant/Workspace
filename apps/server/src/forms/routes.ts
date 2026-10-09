/**
 * Forms on the server (Phase 6 M2): responses become rows, written by the server (so
 * someone who may only view a database can still fill in its form), and public links.
 *
 * - `POST /api/workspaces/:id/forms/:databaseId/:viewId/submit`: from the app, by someone
 *   who can see the database.
 * - `GET|PUT|DELETE …/link`: a form's public link (full access to the database).
 * - `GET|POST /f/<token>`: the public form, for anyone, while the form is "anyone with the
 *   link" and the link is the current one.
 *
 * A response is checked against the form (`validateSubmission`): only its questions, in
 * their properties' shapes. Nothing else of the database is written.
 */
import {
  addRow,
  answersFromFields,
  formQuestions,
  isDatabaseDoc,
  readDatabase,
  validateSubmission,
  type FormConfig,
  type Property,
} from '@workspace/database';
import { getPage } from '@workspace/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as Y from 'yjs';
import { atLeast } from '../access/roles';
import { fail, requireUser } from '../auth/context';
import type { ServerContext } from '../context';
import { HONEYPOT, renderForm, renderGone, renderSubmitted } from './page';

const uuid = { type: 'string', format: 'uuid' } as const;
const docId = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[\\w-]+$' } as const;
const formParams = {
  type: 'object',
  properties: { id: uuid, databaseId: docId, viewId: docId },
} as const;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
/** Largest response (both from the app and the public page). */
const MAX_BODY = 64 * 1024;
const MAX_FIELDS = 200;
/** Public posts per address. */
const PUBLIC_RATE = { max: 10, timeWindow: '1 minute' };
const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

type FormParams = { id: string; databaseId: string; viewId: string };

interface LoadedForm {
  properties: Property[];
  form: FormConfig;
}

export function formRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);
  const { store } = ctx;
  const origin = new URL(ctx.config.publicUrl).origin;
  const linkOf = (token: string) => `${origin}/f/${token}`;

  /** A database's form view, from its merged state; null if there's no such form. */
  async function loadForm(
    workspaceId: string,
    databaseId: string,
    viewId: string,
  ): Promise<LoadedForm | null> {
    const state = await store.docState(workspaceId, databaseId);
    if (!state) return null;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, state);
      if (!isDatabaseDoc(doc)) return null;
      const snapshot = readDatabase(doc);
      const view = snapshot.views.find((v) => v.id === viewId && v.type === 'form');
      return view ? { properties: snapshot.properties, form: view.form } : null;
    } finally {
      doc.destroy();
    }
  }

  /** The database's title (for a form without one). */
  async function databaseTitle(workspaceId: string, databaseId: string): Promise<string> {
    const access = await ctx.access.workspace(workspaceId);
    const scope = access.scope(access.placementOf(databaseId) ?? '');
    const state = scope && (await store.docState(workspaceId, scope.treeDoc));
    if (!state) return '';
    const tree = new Y.Doc();
    Y.applyUpdate(tree, state);
    const title = getPage(tree, databaseId)?.title ?? '';
    tree.destroy();
    return title;
  }

  /** Store a response as a new row (by `submitter`, or nobody), and tell the creator. */
  async function respond(
    workspaceId: string,
    databaseId: string,
    loaded: LoadedForm,
    submission: { title: string; values: Record<string, unknown> },
    submitter: string | null,
  ): Promise<string> {
    const { result: rowId } = await ctx.docs.edit(
      workspaceId,
      databaseId,
      { trusted: true, userId: submitter },
      (doc) =>
        addRow(doc, { actor: submitter, title: submission.title, values: submission.values }),
    );
    const { form } = loaded;
    if (form.notify && form.createdBy && form.createdBy !== submitter) {
      await ctx.notifier
        .formResponse(workspaceId, {
          userId: form.createdBy,
          databaseId,
          rowId,
          formTitle: form.title || (await databaseTitle(workspaceId, databaseId)) || 'Form',
          title: submission.title,
          actorId: submitter,
        })
        .catch((error: unknown) => app.log.warn({ err: error }, 'form response notification'));
    }
    return rowId;
  }

  /** The caller's role on the database (null, after a 404, if they can't see it). */
  async function roleOn(request: FastifyRequest<{ Params: FormParams }>, reply: FastifyReply) {
    const userId = request.auth!.user.id;
    const access = await ctx.access.workspace(request.params.id);
    const role = access.isMember(userId)
      ? access.roles(userId).get(access.placementOf(request.params.databaseId) ?? '')
      : undefined;
    if (!atLeast(role, 'view')) {
      void fail(reply, 404, 'not_found', 'No such form.');
      return null;
    }
    return role!;
  }

  // --- From the app ---------------------------------------------------------------------

  app.post<{ Params: FormParams; Body: { answers: Record<string, unknown> } }>(
    '/api/workspaces/:id/forms/:databaseId/:viewId/submit',
    {
      preHandler: signedIn,
      bodyLimit: MAX_BODY,
      schema: {
        params: formParams,
        body: {
          type: 'object',
          required: ['answers'],
          properties: { answers: { type: 'object', maxProperties: MAX_FIELDS } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { id: workspaceId, databaseId, viewId } = request.params;
      // Anyone who can see the database may fill in its forms (that's what they're for,
      // even with view only): the row is written by the server, not by them.
      if (!(await roleOn(request, reply))) return reply;
      const loaded = await loadForm(workspaceId, databaseId, viewId);
      if (!loaded) return fail(reply, 404, 'not_found', 'No such form.');
      const access = await ctx.access.workspace(workspaceId);
      const submission = validateSubmission(loaded.properties, loaded.form, request.body.answers, {
        members: new Set(access.memberIds()),
      });
      if (!submission.ok) {
        return reply
          .code(400)
          .send({ error: 'invalid', message: 'Check the answers.', errors: submission.errors });
      }
      const rowId = await respond(
        workspaceId,
        databaseId,
        loaded,
        submission,
        request.auth!.user.id,
      );
      return reply.code(201).send({ rowId });
    },
  );

  // --- Public links ---------------------------------------------------------------------

  const fullAccess = async (
    request: FastifyRequest<{ Params: FormParams }>,
    reply: FastifyReply,
  ) => {
    const role = await roleOn(request, reply);
    if (!role) return false;
    if (!atLeast(role, 'full')) {
      void fail(reply, 403, 'forbidden', 'Only someone with full access can share this form.');
      return false;
    }
    if (!(await loadForm(request.params.id, request.params.databaseId, request.params.viewId))) {
      void fail(reply, 404, 'not_found', 'No such form.');
      return false;
    }
    return true;
  };

  app.get<{ Params: FormParams }>(
    '/api/workspaces/:id/forms/:databaseId/:viewId/link',
    { preHandler: signedIn, schema: { params: formParams } },
    async (request, reply) => {
      if (!(await roleOn(request, reply))) return reply;
      const { id, databaseId, viewId } = request.params;
      const link = await store.formLinks.get(id, databaseId, viewId);
      return { link: link && linkOf(link.token) };
    },
  );

  app.put<{ Params: FormParams }>(
    '/api/workspaces/:id/forms/:databaseId/:viewId/link',
    { preHandler: signedIn, schema: { params: formParams } },
    async (request, reply) => {
      if (!(await fullAccess(request, reply))) return reply;
      const { id, databaseId, viewId } = request.params;
      const link = await store.formLinks.create(id, databaseId, viewId, request.auth!.user.id);
      return { link: linkOf(link.token) };
    },
  );

  app.delete<{ Params: FormParams }>(
    '/api/workspaces/:id/forms/:databaseId/:viewId/link',
    { preHandler: signedIn, schema: { params: formParams } },
    async (request, reply) => {
      if (!(await fullAccess(request, reply))) return reply;
      const { id, databaseId, viewId } = request.params;
      await store.formLinks.remove(id, databaseId, viewId);
      return { link: null };
    },
  );

  // --- The public form ------------------------------------------------------------------

  /** The form behind a token, while it's public; null otherwise. */
  async function publicForm(token: string) {
    if (!TOKEN.test(token)) return null;
    const link = await store.formLinks.byToken(token);
    if (!link) return null;
    const loaded = await loadForm(link.workspaceId, link.databaseId, link.viewId);
    if (!loaded || loaded.form.audience !== 'public') return null;
    // Nobody signed in can pick workspace members: person questions aren't asked.
    const form: FormConfig = {
      ...loaded.form,
      questions: formQuestions(loaded.properties, loaded.form)
        .filter((q) => q.property.type !== 'person')
        .map((q) => q.question),
    };
    const fallbackTitle = await databaseTitle(link.workspaceId, link.databaseId);
    return { link, loaded: { ...loaded, form }, fallbackTitle };
  }

  const pageHeaders = (reply: FastifyReply) =>
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', CSP)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('x-robots-tag', 'noindex, nofollow')
      .header('cache-control', 'no-store');

  void app.register(async (scope) => {
    // Plain HTML forms post url-encoded fields; repeated names (multi-select) are lists.
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: MAX_BODY },
      (_request, body, done) => {
        const fields: Record<string, string | string[]> = Object.create(null);
        let count = 0;
        for (const [key, value] of new URLSearchParams(body as string)) {
          if (++count > MAX_FIELDS) return done(new Error('Too many fields'), undefined);
          const previous = fields[key];
          fields[key] =
            previous === undefined
              ? value
              : Array.isArray(previous)
                ? [...previous, value]
                : [previous, value];
        }
        done(null, fields);
      },
    );

    scope.get<{ Params: { token: string } }>('/f/:token', async (request, reply) => {
      const found = await publicForm(request.params.token);
      pageHeaders(reply);
      if (!found) return reply.code(404).send(renderGone());
      const { loaded, fallbackTitle } = found;
      return reply.send(
        renderForm({
          form: loaded.form,
          fallbackTitle,
          questions: formQuestions(loaded.properties, loaded.form),
        }),
      );
    });

    scope.post<{ Params: { token: string }; Body: Record<string, string | string[]> }>(
      '/f/:token',
      { config: { rateLimit: PUBLIC_RATE } },
      async (request, reply) => {
        const found = await publicForm(request.params.token);
        pageHeaders(reply);
        if (!found) return reply.code(404).send(renderGone());
        const { link, loaded, fallbackTitle } = found;
        const fields: Record<string, string | string[]> = Object.create(null);
        const body = (request.body ?? {}) as Record<string, string | string[]>;
        for (const [key, value] of Object.entries(body)) if (key !== HONEYPOT) fields[key] = value;
        // A robot filled in the field people don't see: thank it, keep nothing.
        const honeypot = body[HONEYPOT];
        if (typeof honeypot === 'string' && honeypot !== '') {
          return reply.send(renderSubmitted(loaded.form, fallbackTitle));
        }
        const answers = answersFromFields(loaded.properties, loaded.form, fields);
        const submission = validateSubmission(loaded.properties, loaded.form, answers);
        if (!submission.ok) {
          const questions = formQuestions(loaded.properties, loaded.form);
          const asked = new Set(questions.map((q) => q.property.id));
          // Errors about fields that aren't questions show at the top.
          const errors = new Map<string | null, string>();
          for (const e of submission.errors) {
            if (e.propertyId !== null && asked.has(e.propertyId))
              errors.set(e.propertyId, e.message);
            else errors.set(null, 'Something sent isn’t part of this form.');
          }
          return reply
            .code(400)
            .send(
              renderForm({ form: loaded.form, fallbackTitle, questions, values: fields, errors }),
            );
        }
        await respond(link.workspaceId, link.databaseId, loaded, submission, null);
        return reply.send(renderSubmitted(loaded.form, fallbackTitle));
      },
    );
  });
}
