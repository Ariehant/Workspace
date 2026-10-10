# Self-hosting the server

The server adds sync between devices, teams and sharing, the web app, publishing, automations
that run around the clock, and the Notion-compatible API. It runs with Docker Compose on Ubuntu
24.04: Caddy (automatic HTTPS), the server, and Postgres 16, with attachments on a volume or in
S3.

**Contents:** [Start it](#start-it) · [Settings](#settings) · [Accounts and invites](#accounts-and-invites) ·
[Single sign-on](#single-sign-on) · [Email](#email) · [Attachments in S3](#attachments-in-s3) ·
[Webhooks](#webhooks) · [The admin CLI](#the-admin-cli) · [Backups](#backups) ·
[Upgrades](#upgrades) · [Running under systemd](#running-under-systemd) ·
[Clients](#clients)

## Start it

You need Docker with the Compose plugin, and a domain whose DNS points at the machine (or
`localhost` to try it out).

```sh
git clone https://github.com/Ariehant/Workspace.git
cd Workspace/infra
cp .env.example .env     # set DOMAIN and POSTGRES_PASSWORD
docker compose up -d --build   # builds the server image from the repository
```

Caddy gets a certificate from Let's Encrypt for `DOMAIN` (or uses its own local CA for
`localhost`), and redirects plain HTTP to HTTPS. Check that it's up:

```sh
curl https://<DOMAIN>/api/ready      # {"ok":true,"checks":{"database":"ok","files":"ok"}}
```

The first account created becomes the server admin.

## Settings

Set these in `infra/.env` ([`.env.example`](../infra/.env.example) has them all, with
comments):

| Variable                                      | What it does                                                                |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `DOMAIN`                                      | The address people reach the server at                                      |
| `POSTGRES_PASSWORD`                           | The database password (use a long random value)                             |
| `SIGNUP`                                      | Who can create accounts: `open`, `invite` (default) or `disabled`           |
| `OIDC_*`                                      | Single sign-on providers (see [below](#single-sign-on))                     |
| `SMTP_URL`, `SMTP_FROM`                       | Email for invites and notification digests (see [below](#email))            |
| `S3_*`                                        | Attachments in S3 (see [below](#attachments-in-s3))                         |
| `WEBHOOK_ALLOW_PRIVATE`, `WEBHOOK_ALLOW_HTTP` | Let webhooks reach private addresses or plain HTTP (see [below](#webhooks)) |
| `MAX_FILE_MB`                                 | The largest attachment (default 512)                                        |
| `LOG_LEVEL`                                   | `info` (default), or `trace`, `debug`, `warn`, `error`, `fatal`, `silent`   |

## Accounts and invites

After the first account, `SIGNUP` decides who can join. On an invite-only server, people sign up
through an invite: a workspace's owners and admins invite people from **Members → Invite**, and
server admins can make one from the [admin CLI](#the-admin-cli). Roles in a workspace are owner,
admin, member and guest; pages and teamspaces are shared on top of that.

## Single sign-on

Any OpenID Connect provider works (GitLab, Google, Keycloak, Authentik…). For each provider,
register `https://<DOMAIN>/api/auth/oidc/<id>/callback` as a redirect URI, then:

```sh
OIDC_PROVIDERS=gitlab
OIDC_GITLAB_ISSUER=https://gitlab.com
OIDC_GITLAB_CLIENT_ID=...
OIDC_GITLAB_CLIENT_SECRET=...
OIDC_GITLAB_NAME=GitLab
```

Several providers are separated by commas in `OIDC_PROVIDERS`, each with its own `OIDC_<ID>_*`
settings. Accounts are matched by verified email address.

## Email

With `SMTP_URL` and `SMTP_FROM` set, the server emails invites, and sends people digests of
inbox items they haven't seen: after a mention (once it's been unread for 10 minutes), or once
a day, as each person chooses in **Your profile**. Every digest has a one-click unsubscribe
link. Without SMTP, invite links are shown to copy and send, and nobody gets digests.

```sh
SMTP_URL=smtps://user:password@smtp.example.com:465
SMTP_FROM=Workspace <notes@example.com>
```

## Attachments in S3

By default attachments are on a Docker volume. To keep them in S3 (AWS, MinIO, SeaweedFS…), add
the S3 file to the stack and set the bucket and keys:

```sh
docker compose -f docker-compose.yml -f docker-compose.s3.yml up -d
```

`docker-compose.s3.yml` starts a SeaweedFS S3 server; point `S3_ENDPOINT` at your own S3 instead
and drop that service if you have one.

## Webhooks

Automations, buttons and integrations can send webhooks. By default they only go to public
`https://` addresses: private, loopback and link-local addresses (cloud metadata services among
them) are refused after DNS resolution, and redirects aren't followed. To reach a service on
your own network, set `WEBHOOK_ALLOW_PRIVATE=true` (and `WEBHOOK_ALLOW_HTTP=true` for plain
HTTP).

## The admin CLI

```sh
docker compose exec server workspace-admin <command>
```

| Command                                | What it does                                            |
| -------------------------------------- | ------------------------------------------------------- |
| `create-user <email> [name] [--admin]` | Create an account; prints its generated password        |
| `reset-password <email>`               | Set a new generated password and sign out everywhere    |
| `create-invite [email] [--days N]`     | Print an invite code (for anyone, or only that email)   |
| `list-users`                           | List accounts                                           |
| `disable-user <email>`, `enable-user`  | Disable an account (and sign it out), or re-enable it   |
| `make-admin <email>`                   | Make an account a server admin                          |
| `list-workspaces`                      | List workspaces with their members and sizes            |
| `reindex [workspace id]`               | Rebuild the search index                                |
| `compact [threshold]`                  | Merge long update logs (the server also does it hourly) |
| `migrate`                              | Apply database migrations                               |

## Backups

[`backup.sh`](../infra/backup.sh) dumps the database and copies the attachments:

```sh
cd infra
./backup.sh /var/backups/workspace
```

It prints the commands to restore. With attachments in S3, back up the bucket with your
provider's tools instead.

## Upgrades

Pull the new code, rebuild the image and restart. The server applies database migrations when it
starts:

```sh
git pull
cd infra && docker compose up -d --build
```

Back up first: migrations only go forward.

## Running under systemd

[`workspace.service`](../infra/workspace.service) starts the stack at boot, from
`/opt/workspace`. Build the image once from the repository (`docker compose up -d --build`, as
above), then:

```sh
sudo cp -r infra /opt/workspace
sudo cp infra/workspace.service /etc/systemd/system/
sudo systemctl enable --now workspace
```

## Clients

- **In a browser:** open `https://<DOMAIN>`. The web app is the same UI. It keeps only the pages
  you open and works while connected; export, import, backups and page history are desktop
  features.
- **On a desktop:** open **Sync** in the sidebar and enter `https://<DOMAIN>` (see the
  [desktop guide](desktop.md#sync)).
- **Integrations:** see the [API guide](api.md).
