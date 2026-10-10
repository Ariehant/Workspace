# The API

Workspace's server has a REST API in the shape of [Notion's](https://developers.notion.com/reference/intro),
at `/v1` on your server's address. Existing integrations and Notion's official SDKs work against
it: point them at your server instead of `api.notion.com`.

**Contents:** [Quick start](#quick-start) · [Integrations and tokens](#integrations-and-tokens) ·
[Versions](#versions) · [Endpoints](#endpoints) · [Conventions and limits](#conventions-and-limits) ·
[Webhooks](#webhooks) · [Differences from Notion](#differences-from-notion)

## Quick start

1. In the app, open **Members → Integrations** (owners and admins), make an integration and copy
   its token (`ntn_…`). It's shown once.
2. Connect the pages it may use: a page's **Share → Connections** (or `···` → Connections). Pages
   under a connected page are included, as with sharing to a person.
3. Call the API with the token:

```js
import { Client } from '@notionhq/client';

const notion = new Client({
  auth: process.env.WORKSPACE_TOKEN,
  baseUrl: 'https://notes.example.com',
});

const page = await notion.pages.create({
  parent: { page_id: '…' },
  properties: { title: { title: [{ text: { content: 'From a script' } }] } },
  children: [{ paragraph: { rich_text: [{ text: { content: 'Hello!' } }] } }],
});
```

Or with `curl`:

```sh
curl https://notes.example.com/v1/search \
  -H "Authorization: Bearer $WORKSPACE_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"query": "Roadmap"}'
```

## Integrations and tokens

- **An integration is a bot user** in its workspace. It shows up by name in "Created by", can't
  sign in, and gets no notifications.
- **It sees only what's connected to it,** through the same access checks as people: edit or
  view access, inherited down the page tree. Search returns only those pages.
- **Its token** is stored as a hash and shown once. **New token** replaces it at once.
- **Capabilities,** set in Members → Integrations and checked on every request: read, update
  and insert content; read and insert comments; and user information (none, without emails, or
  with emails).
- **Tokens and sessions don't mix:** API tokens are refused on the app's own routes, and session
  cookies on `/v1`.

## Versions

The `Notion-Version` header is required, as with Notion:

- **`2022-06-28`:** databases are queried directly (`POST /v1/databases/:id/query`).
- **`2025-09-03`:** a database has a data source (`/v1/data_sources/:id`). Each database here has
  exactly one, with the same id.

## Endpoints

| Area         | Endpoints                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| Users        | `GET /v1/users`, `GET /v1/users/:id`, `GET /v1/users/me`                                                         |
| Pages        | `POST /v1/pages`, `GET /v1/pages/:id`, `PATCH /v1/pages/:id`, `GET /v1/pages/:id/properties/:property`           |
| Databases    | `POST /v1/databases`, `GET /v1/databases/:id`, `PATCH /v1/databases/:id`, `POST /v1/databases/:id/query`         |
| Data sources | `GET /v1/data_sources/:id`, `PATCH /v1/data_sources/:id`, `POST /v1/data_sources/:id/query`                      |
| Blocks       | `GET /v1/blocks/:id`, `PATCH /v1/blocks/:id`, `DELETE /v1/blocks/:id`, `GET` and `PATCH /v1/blocks/:id/children` |
| Comments     | `GET /v1/comments?block_id=`, `POST /v1/comments`                                                                |
| Search       | `POST /v1/search`                                                                                                |

Pages can be made in a page or a database, with properties, content (`children`), an emoji icon
and a cover; changed; and trashed. Database queries take Notion's filter and sort JSON
(compound `and`/`or`, nested two deep). Blocks are appended with `after`, changed and deleted
by id, while people edit the same page live.

## Conventions and limits

- **Errors:** `{ "object": "error", "status", "code", "message" }` with Notion's codes:
  `invalid_json`, `invalid_request_url`, `invalid_request`, `validation_error`,
  `missing_version`, `unauthorized`, `restricted_resource`, `object_not_found`,
  `conflict_error`, `rate_limited` and `internal_server_error`.
- **Pagination:** `start_cursor` and `page_size` (up to 100); responses have `has_more` and
  `next_cursor`.
- **Rate limit:** 3 requests a second per integration on average, in bursts of up to 30;
  beyond that, `429 rate_limited` with `Retry-After`.
- **Size:** 500 KB per request; 100 blocks per append, two levels deep; 1,000 block elements per
  request; 2,000 characters per rich-text item.
- **Ids:** UUIDs, with or without dashes.
- **Files:** stored files come out as signed URLs that work for an hour without signing in;
  external files as their URLs.

## Webhooks

An integration can have one webhook subscription (**Members → Integrations → Webhook**): a URL
and the events it wants.

1. **Verification:** when you save the URL, the server POSTs `{"verification_token": "secret_…"}`
   to it. Paste that token into the settings to turn deliveries on.
2. **Events:** `page.created`, `page.properties_updated`, `page.content_updated`, `page.moved`,
   `page.deleted`, `page.undeleted`, `page.locked`, `page.unlocked`, `database.created`,
   `database.schema_updated`, `database.deleted`, `comment.created`, `comment.updated` and
   `comment.deleted`, only for pages the integration can read when the event is sent.
3. **Payloads** carry ids, as Notion's do: the event's `id`, `type`, `timestamp`, `entity`,
   `authors`, `workspace_id`, `integration_id`, `attempt_number` and `data` (the parent, and the
   changed properties where it applies). Fetch the rest through the API.
4. **Merging:** content changes to a page within a minute arrive as one `page.content_updated`.
5. **Retries and pausing:** failed deliveries are retried for about a day. After 3 days of
   failures the subscription is paused and the integration's maker is told; **Resume** turns it
   back on.

Each delivery is signed with the verification token, as Notion signs them. Check it like this:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function isFromWorkspace(rawBody, signatureHeader, verificationToken) {
  const expected = `sha256=${createHmac('sha256', verificationToken).update(rawBody).digest('hex')}`;
  return (
    signatureHeader.length === expected.length &&
    timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected))
  );
}
```

Webhooks only go to public `https://` addresses unless the server allows otherwise (see
[self-hosting](self-hosting.md#webhooks)).

## Differences from Notion

- **Deleting a block removes it** (page history keeps it); the API can't restore it.
- **Table rows are read-only** through the API.
- **Paragraphs can't hold blocks:** children sent under a paragraph come after it.
- **Blocks have no author:** their `created_by` and `last_edited_by` have a null id.
- **Uploads aren't supported:** files go in as external URLs.
- **Text properties hold plain text:** formatting inside a text property's value isn't kept.
  Titles and page content keep theirs.
- **Comments on selected text** report the page as their parent.
- **Icons and covers:** emoji icons can be set, and covers removed; images as icons or covers
  can't be set through the API yet.
- **Public (OAuth) integrations** aren't supported: internal integrations with tokens cover
  self-hosting.

How it was checked: the official SDK runs against the server in both versions
(`apps/server/src/api.conformance.test.ts`), and published Notion tools run unchanged
(`apps/server/src/real-world.test.ts`). The design notes are in [PHASE6.md](PHASE6.md).
