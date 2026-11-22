# Documentation

## Using Workspace

| Guide                                      | What's in it                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| [Getting started](getting-started.md)      | A short tour: pages, databases, finding things, importing, working together |
| [Features](features.md)                    | Everything the app and the server do, area by area                          |
| [The desktop app](desktop.md)              | Installing, where your data lives, backups, sync, keyboard shortcuts        |
| [Self-hosting the server](self-hosting.md) | Docker Compose, settings, single sign-on, email, S3, backups, the admin CLI |
| [The API](api.md)                          | Integrations, tokens, endpoints, webhooks, and differences from Notion      |

## How it's built

| Document                                        | What's in it                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| [Plan](PLAN.md)                                 | The architecture, the feature inventory, the roadmap and the main risks     |
| [Phase 1](PHASE1.md)                            | The editor and navigation                                                   |
| [Phase 2](PHASE2.md)                            | Databases: properties, views, formulas, relations                           |
| [Phase 3](PHASE3.md)                            | Synced blocks, buttons, history, backlinks, tabs, templates, import, export |
| [Phase 4](PHASE4.md)                            | The sync server, accounts, desktop sync and the web app                     |
| [Phase 5](PHASE5.md)                            | Members, permissions, presence, comments, the inbox, publishing             |
| [Phase 6](PHASE6.md)                            | Forms, automations, the Notion-compatible API, webhooks, email digests      |
| [Phase 7](PHASE7.md)                            | Polish and release: performance, accessibility, languages, packaging, v1.0  |
| [Phase 8](PHASE8.md)                            | What Notion has that Workspace didn't: the gap list, and adding it          |
| [Ideas](ideas/desktop-integration.md)           | Parked: the desktop app as a native productivity app                        |
| [Calendar app guide](calendar-app/README.md)    | Workspace Calendar: install, connect, use, notifications, troubleshooting   |
| [Calendar app handoff](calendar-app/HANDOFF.md) | A build plan for Workspace Calendar, which uses the API                     |
| [Calendar app context](calendar-app/CONTEXT.md) | What a new chat needs to start building Workspace Calendar in this repo     |
| [Docs app handoff](docs-app/HANDOFF.md)         | A build plan for Workspace Write, a document editor (AI in v2)              |

Each phase document has the plan, then notes on each milestone as it was done: what changed from
the plan and why, what was built, the tests, and the test runs.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md).
