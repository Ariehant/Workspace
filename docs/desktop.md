# The desktop app

Workspace's desktop app works fully on its own: no account, no server, everything saved on your
computer as you type. This guide covers installing it, where it keeps your data, and connecting
it to a server.

**Contents:** [Install](#install) · [Where your data lives](#where-your-data-lives) ·
[Backups](#backups) · [Several workspaces](#several-workspaces) · [Sync](#sync) ·
[Keyboard shortcuts](#keyboard-shortcuts) · [Troubleshooting](#troubleshooting)

## Install

Workspace runs on Ubuntu 24.04 and later (x86-64); other modern Linux desktops should work too.
There are no published releases yet, so build the packages from source (Node.js 22.13 or later,
pnpm 10):

```sh
corepack enable
pnpm install
pnpm package        # apps/desktop/dist/: a .deb and an AppImage
```

**The `.deb` (recommended):**

```sh
sudo apt install ./apps/desktop/dist/workspace-app_*_amd64.deb
workspace-app
```

It adds Workspace to the applications menu, registers `workspace://` links, and installs an
AppArmor profile so Chromium's sandbox works under Ubuntu 24.04's user-namespace restrictions.

**The AppImage:** Ubuntu 24.04 needs FUSE 2 (`sudo apt install libfuse2t64`). Ubuntu's AppArmor
policy also blocks the Chromium sandbox for AppImages, so prefer the `.deb` until signed
AppImage profiles are in place ([Phase 7](PHASE7.md)).

## Where your data lives

| What                                 | Where                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------- |
| The workspace (pages, content)       | `~/.local/share/workspace-app/workspace.db` (honours `$XDG_DATA_HOME`) |
| Attachments (images, PDFs, files)    | `~/.local/share/workspace-app/files/`                                  |
| Chromium profile (caches, GPU state) | `~/.config/Workspace/`                                                 |

With sync on, the database also holds the changes waiting to be sent, and the sign-in
(encrypted with the system keyring when there is one).

## Backups

- **From the app:** click **Workspace** at the top of the sidebar to back up the whole workspace
  to a `.zip`, or to restore one. The same menu exports it as Markdown & CSV, HTML or PDF.
- **By hand:** copy `workspace.db` and the `files/` folder while the app is closed.

## Several workspaces

Set `WORKSPACE_DATA_DIR` to keep a workspace somewhere else, for example one per project:

```sh
WORKSPACE_DATA_DIR=~/notes/lab workspace-app
```

## Sync

Open **Sync** in the sidebar (or File → Sync…) and enter your server's address. Sign in with a
password or single sign-on, then upload this workspace or use one from the server. You keep
working offline; changes and attachments sync when the connection is back. Setting up a server
is covered in the [self-hosting guide](self-hosting.md).

## Keyboard shortcuts

| Shortcut                     | Does                                        |
| ---------------------------- | ------------------------------------------- |
| `Ctrl+K` or `Ctrl+P`         | Quick find (`Ctrl+Enter`: in a new window)  |
| `Ctrl+N`                     | New page                                    |
| `Ctrl+T` / `Ctrl+W`          | New tab / close tab                         |
| `Ctrl+Tab`                   | Next tab                                    |
| `Ctrl+Shift+N`               | New window                                  |
| `Alt+←` / `Alt+→`            | Back / forward                              |
| `Ctrl+\`                     | Show or hide the sidebar                    |
| `Ctrl+F`                     | Find and replace in the page                |
| `/`                          | Insert a block                              |
| `@`                          | Mention a page, a person or a date          |
| `Ctrl+Shift+M`               | Comment on the selection (server workspace) |
| `Ctrl+B`, `Ctrl+I`, `Ctrl+U` | Bold, italic, underline                     |
| `Ctrl+E`                     | Inline code                                 |
| `Tab` / `Shift+Tab`          | Indent / outdent                            |

## Troubleshooting

- **The app doesn't start from a terminal as root** (containers, CI): Chromium refuses its
  sandbox as root. Run as a normal user, or pass `--no-sandbox` for a one-off test.
- **The AppImage closes at once:** install `libfuse2t64`, or use the `.deb` (see
  [Install](#install)).
- **Main-process errors:** run `workspace-app` from a terminal to see its log.
