# The desktop app

Workspace's desktop app works fully on its own: no account, no server, everything saved on your
computer as you type. This guide covers installing it, where it keeps your data, and connecting
it to a server.

**Contents:** [Install](#install) · [Where your data lives](#where-your-data-lives) ·
[Backups](#backups) · [Several workspaces](#several-workspaces) · [Sync](#sync) ·
[Keyboard shortcuts](#keyboard-shortcuts) · [Language and region](#language-and-region) ·
[Accessibility](#accessibility) · [Troubleshooting](#troubleshooting)

## Install

Workspace runs on Ubuntu 24.04 and later (x86-64); other modern Linux desktops should work too.
Each release on [GitHub](https://github.com/ariehant/workspace/releases) has a `.deb`, an
AppImage, a Snap and a Flatpak, with `SHA256SUMS` (signed, `.asc`, once the project's key is
set up). Until the first release, build them from source, below.

**From the apt repository (recommended):** updates come with `apt upgrade`.

```sh
curl -fsSL https://ariehant.github.io/workspace/apt/workspace-archive-keyring.gpg \
  | sudo tee /usr/share/keyrings/workspace-archive-keyring.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/workspace-archive-keyring.gpg] https://ariehant.github.io/workspace/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/workspace.list
sudo apt update && sudo apt install workspace-app
```

The `.deb` adds Workspace to the applications menu, registers `workspace://` links, and installs
an AppArmor profile so Chromium's sandbox works under Ubuntu 24.04's user-namespace rules. A
downloaded `.deb` installs the same way: `sudo apt install ./workspace-app_*_amd64.deb`.

**The AppImage** updates itself: it downloads a new release in the background and offers
**Restart to update** in the sidebar (turn that off, or check now, in Workspace menu → About
Workspace). Ubuntu 24.04 needs FUSE 2 (`sudo apt install libfuse2t64`), and its AppArmor rules
block the Chromium sandbox for programs without a profile. To give the AppImage one, save this
as `/etc/apparmor.d/workspace-appimage` and run `sudo apparmor_parser -r` on it:

```text
abi <abi/4.0>,
include <tunables/global>

profile workspace-appimage /tmp/.mount_Worksp*/workspace-app flags=(unconfined) {
  userns,
  include if exists <local/workspace-appimage>
}
```

**The Snap** (`sudo snap install workspace-app`, once it is in the Snap Store) and **the
Flatpak** (from Flathub, once listed) update through their stores.

**From source** (Node.js 22.13 or later, pnpm 10):

```sh
corepack enable
pnpm install
pnpm package        # apps/desktop/dist/: a .deb and an AppImage
sudo apt install ./apps/desktop/dist/workspace-app_*_amd64.deb
```

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

## Import from other apps

**Import** in the sidebar takes the files each app exports. Everything lands under a new page
named after the file (**Import**, for several files), and a report lists what came across and what didn't.

| From       | Export there                                                       | Import            |
| ---------- | ------------------------------------------------------------------ | ----------------- |
| Notion     | Settings → Export all workspace content, Markdown & CSV or HTML    | the `.zip`        |
| Evernote   | Select notes or a notebook → Export → ENEX (one file per notebook) | the `.enex` files |
| Trello     | Board menu → Print, export and share → Export as JSON              | the `.json`       |
| Confluence | Space settings → Export space → HTML                               | the `.zip`        |
| Anything   | Markdown, HTML, CSV or text files                                  | the files         |

Each Evernote notebook becomes a database of its notes (tags, created and updated dates and
the source address as columns). A Trello board becomes a database shown as a board grouped by
list; its attachments come across as links (the files stay on Trello) and archived cards are
left out. A Confluence space becomes its page tree. Encrypted text in Evernote notes can't come
across.

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
| `Ctrl+=` / `Ctrl+-`          | Zoom in / out (also `Ctrl` + mouse wheel)   |
| `Ctrl+0`                     | Actual size (100%)                          |
| `Ctrl+F`                     | Find and replace in the page                |
| `/`                          | Insert a block                              |
| `@`                          | Mention a page, a person or a date          |
| `Ctrl+Shift+M`               | Comment on the selection (server workspace) |
| `Ctrl+B`, `Ctrl+I`, `Ctrl+U` | Bold, italic, underline                     |
| `Ctrl+E`                     | Inline code                                 |
| `Tab` / `Shift+Tab`          | Indent / outdent                            |

In the sidebar's page tree, `↑` `↓` move between pages, `→` `←` expand and collapse, and
`Enter` opens the page. In a database table, the arrow keys move between cells, `Enter` or
typing edits one, and `Tab` moves along the row (and on out of the table past its end).

The zoom applies to every window and is remembered. **Appearance** in the sidebar shows the
level, with Zoom in, Zoom out and Actual size; so does the View menu (press `Alt` to show the
menu bar).

## Language and region

**Workspace menu → Language and region…** sets how dates, times and numbers look: pick your
region (it starts as your system's), or set the date format, the 12- or 24-hour clock and the
first day of the week on their own. The app's text is in English for now. A database property
with its own date or number format keeps it.

## Accessibility

- **Keyboard:** pages, databases, sharing and settings work without a mouse. Moving a page to
  another parent works from its menu (Move to), and moving a card or a date from the row's
  properties. Buttons that show on hover show when focused too, and dialogs return the focus
  to what opened them.
- **Screen readers:** controls have names and roles, and sync changes and new notifications are
  announced. Tested with axe in both themes; checked by hand with Orca before each release.
- **Contrast:** text meets WCAG AA (4.5:1) in the light and dark themes.
- **Zoom:** see [Keyboard shortcuts](#keyboard-shortcuts).
- **Less motion:** with the system's reduced motion setting on (GNOME: Settings → Accessibility
  → Reduce Animation), the app drops its animations and smooth scrolling.

## Troubleshooting

- **The app doesn't start from a terminal as root** (containers, CI): Chromium refuses its
  sandbox as root. Run as a normal user, or pass `--no-sandbox` for a one-off test.
- **The AppImage closes at once:** install `libfuse2t64`, or use the `.deb` (see
  [Install](#install)).
- **Main-process errors:** run `workspace-app` from a terminal to see its log.
