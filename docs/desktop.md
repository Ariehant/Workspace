# The desktop app

Workspace's desktop app works fully on its own: no account, no server, everything saved on your
computer as you type. This guide covers installing it, where it keeps your data, and connecting
it to a server.

**Contents:** [Install](#install) · [Where your data lives](#where-your-data-lives) ·
[Backups](#backups) · [Several workspaces](#several-workspaces) · [Sync](#sync) ·
[Keyboard shortcuts](#keyboard-shortcuts) · [Language and region](#language-and-region) ·
[Accessibility](#accessibility) · [Troubleshooting](#troubleshooting)

## Install

Workspace runs on Windows 10 and 11 (x64), and on Ubuntu 24.04 and later (x86-64); other modern
Linux desktops should work too.

### Windows

Download `Workspace-Setup-<version>.exe` from the Assets of the
[latest-build](https://github.com/Ariehant/Workspace/releases/tag/latest-build) pre-release and
run it. It installs for your user, without administrator rights, adds Workspace to the Start
menu, and registers `workspace://` links the first time the app starts. Uninstall it from
**Settings → Apps**; that leaves your data in place.

The installer isn't signed yet, so SmartScreen may say "Windows protected your PC": choose
**More info**, then **Run anyway**. The app doesn't update itself on Windows yet: to update,
download and run a newer installer, which keeps your data.

### Ubuntu and other Linux desktops

Each release on the repository's [Releases](https://github.com/Ariehant/Workspace/releases) page
has a `.deb`, an AppImage, a Snap and a Flatpak, with `SHA256SUMS` (signed, `.asc`, once the
project's key is set up). The first will be a release candidate, `v1.0.0-rc.1`: download the
`.deb` from its Assets and install it with `sudo apt install ~/Downloads/workspace-app_*_amd64.deb`.

**The latest build** (until the first release is out): the
[latest-build](https://github.com/Ariehant/Workspace/releases/tag/latest-build) pre-release has
the `.deb` and AppImage of `main` as it is now. CI publishes it after its tests pass and replaces
it with every change; it isn't signed and doesn't update itself, so install a newer one the same
way.

**From the apt repository** (from v1.0.0; release candidates aren't published to it): updates
come with `apt upgrade`.

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
git clone https://github.com/Ariehant/Workspace.git
cd Workspace
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

On Windows, the workspace and its attachments are in `%APPDATA%\workspace-app\` (`workspace.db`
and `files\`), and Chromium's profile is in `%APPDATA%\Workspace\`. Paste
`%APPDATA%\workspace-app` into File Explorer's address bar to open the folder.

With sync on, the database also holds the changes waiting to be sent, and the sign-in
(encrypted with the system keyring when there is one).

## Backups

- **From the app:** click **Workspace** at the top of the sidebar to back up the whole workspace
  to a `.zip`, or to restore one. The same menu exports it as Markdown & CSV, HTML or PDF.
- **By hand:** copy `workspace.db` and the `files/` folder while the app is closed.

## Import from other apps

**Import** in the sidebar takes the files each app exports. Everything lands under a new page
named after the file (**Import**, for several files), and a report lists what came across and what didn't.

| From        | Export there                                                       | Import            |
| ----------- | ------------------------------------------------------------------ | ----------------- |
| Notion      | Settings → Export all workspace content, Markdown & CSV or HTML    | the `.zip`        |
| Evernote    | Select notes or a notebook → Export → ENEX (one file per notebook) | the `.enex` files |
| Trello      | Board menu → Print, export and share → Export as JSON              | the `.json`       |
| Asana       | The project's menu → Export/Print → CSV                            | the `.csv`        |
| Jira        | Filters → the issues to move → Export → Export CSV (all fields)    | the `.csv`        |
| monday.com  | The board's menu → Export board to Excel                           | the `.xlsx`       |
| Confluence  | Space settings → Export space → HTML                               | the `.zip`        |
| Word        | Save as Word Document (`.docx`)                                    | the `.docx` files |
| Google Docs | File → Download → Microsoft Word (`.docx`)                         | the `.docx` files |
| Anything    | Markdown, HTML, CSV or text files                                  | the files         |

Each Evernote notebook becomes a database of its notes (tags, created and updated dates and
the source address as columns). A Trello board becomes a database shown as a board grouped by
list; its attachments come across as links (the files stay on Trello) and archived cards are
left out. An Asana project or a Jira export becomes a database shown as a board (by section, or
by status) and a table; sub-tasks become sub-items of their parent, and columns the importer
doesn't know (custom fields) come across as text. A monday.com board becomes a database by
status with its groups, its timeline as a date range and subitems as sub-items; other Excel
workbooks aren't imported yet. Jira's wiki formatting in descriptions stays
as plain text. A Confluence space becomes its page tree. Encrypted text in Evernote notes can't come
across. A single Word document becomes the page itself, titled from its Title (or its file
name); its pictures are stored with it. Older `.doc` files need saving as `.docx` first.

## Linked files

`/linked file` in a page links files on this computer without copying them into the
workspace, for files too big or too often changed to import (CAD models, rosbags, datasets).
The page keeps a pointer: the file's name, size and date, and where it is.

- **Linked folders** (Settings → Linked folders): give a folder a name, such as "Projects", and
  choose where it is on this computer. Files linked from inside it are kept as "Projects/…",
  so they open on any computer that links a "Projects" folder too: the same folder kept in
  sync by Dropbox, Syncthing or git, or a copy. Each computer chooses its own place for it.
- **Other files** are kept by their full path, and open on the computer they were linked on.
- **Safety:** pages are shared, so nothing opens by itself. A file opens when you click it;
  a program or script (an executable, `.sh`, `.AppImage`, `.desktop`…) asks first. The page
  can't change where a linked folder is: only Settings can.
- **Moved or missing:** the link says so; **Locate…** points it at the new place.

## Google Drive

`/google drive` links files from Google Drive into a page, picked with Google's own Picker.
Each becomes a card with its name, kind, size and date, kept current while Drive is connected
(renamed, changed, deleted); it opens in Drive. Workspace asks Google only for `drive.file`:
it can see the files you pick and nothing else in your Drive. The sign-in stays on this
computer (encrypted by the system keyring where there is one).

It needs your own Google Cloud project, once:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or use
   one) and note its **project number** (Dashboard → Project info).
2. **APIs & Services → Library:** enable the **Google Drive API** and the **Google Picker
   API**.
3. **OAuth consent screen:** user type External (or Internal in a Google Workspace
   organisation), the app's name and your email; under scopes add `.../auth/drive.file`. While
   the app is "Testing", add yourself as a test user; publish it (no review is needed for
   `drive.file`) so the sign-in doesn't lapse after 7 days.
4. **Credentials → Create credentials → OAuth client ID**, type **Desktop app**: note the
   client ID and client secret (for a desktop app it isn't kept secret).
5. **Credentials → Create credentials → API key**, restricted to the Google Picker API.
6. In Workspace: **Settings → Connections**, enter the four, **Save**, then **Connect Google
   Drive…** and allow it in the browser.

A build can bring the client instead (`WORKSPACE_GOOGLE_CLIENT_ID`,
`WORKSPACE_GOOGLE_CLIENT_SECRET`, `WORKSPACE_GOOGLE_API_KEY`, `WORKSPACE_GOOGLE_APP_ID`).
**Disconnect** in Settings signs out and tells Google; the cards keep what they last knew.
On the web app and on computers not connected, a card shows that and links to Drive.

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

**Keyboard shortcuts** in the workspace menu (or `Ctrl+?`) lists these in the app.

| Shortcut                               | Does                                                      |
| -------------------------------------- | --------------------------------------------------------- |
| `Ctrl+K` or `Ctrl+P`                   | Quick find (`Ctrl+Enter`: in a new window)                |
| `Ctrl+N`                               | New page                                                  |
| `Ctrl+T` / `Ctrl+W`                    | New tab / close tab                                       |
| `Ctrl+Tab`                             | Next tab                                                  |
| `Ctrl+Shift+N`                         | New window                                                |
| `Alt+←` / `Alt+→`, `Ctrl+[` / `Ctrl+]` | Back / forward                                            |
| `Ctrl+Shift+U`                         | Go to the parent page                                     |
| `Ctrl+\`                               | Show or hide the sidebar                                  |
| `Ctrl+Shift+L`                         | Dark or light mode                                        |
| `Ctrl+=` / `Ctrl+-`                    | Zoom in / out (also `Ctrl` + mouse wheel)                 |
| `Ctrl+0`                               | Actual size (100%)                                        |
| `Ctrl+F`                               | Find and replace in the page                              |
| `Ctrl+?`                               | List the keyboard shortcuts                               |
| `/`                                    | Insert a block, or a command (`/red`, `/turn into h2`, …) |
| `@`                                    | Mention a page, a person or a date                        |
| `:`                                    | Emoji                                                     |
| `Ctrl+B`, `Ctrl+I`, `Ctrl+U`           | Bold, italic, underline                                   |
| `Ctrl+Shift+S`                         | Strikethrough                                             |
| `Ctrl+E` / `Ctrl+Shift+E`              | Inline code / inline equation                             |
| `Ctrl+Shift+H`                         | The colour used last                                      |
| `Ctrl+Shift+M`                         | Comment on the selection                                  |
| `Tab` / `Shift+Tab`                    | Indent / outdent                                          |
| `Shift+↑` / `Shift+↓`                  | Select blocks                                             |
| `Ctrl+Shift+↑` / `Ctrl+Shift+↓`        | Move the block (or the selected blocks) up / down         |
| `Ctrl+D`                               | Duplicate the block (or the selected blocks)              |
| `Ctrl+Enter`                           | Check a to-do, or open or close a toggle                  |
| `Ctrl+Alt+0`                           | Turn into text                                            |
| `Ctrl+Alt+1` / `2` / `3`               | Turn into a heading 1 / 2 / 3                             |
| `Ctrl+Alt+4` / `5` / `6`               | Turn into a to-do / bulleted list / numbered list         |
| `Ctrl+Alt+7` / `8`                     | Turn into a toggle / code                                 |
| `Ctrl+Alt+9`                           | A new sub-page here                                       |

In the sidebar's page tree, `↑` `↓` move between pages, `→` `←` expand and collapse, and
`Enter` opens the page. In a database table, the arrow keys move between cells, `Enter` or
typing edits one, and `Tab` moves along the row (and on out of the table past its end).

The zoom applies to every window and is remembered. **Appearance** in the sidebar shows the
level, with Zoom in, Zoom out and Actual size; so does the View menu (press `Alt` to show the
menu bar).

## Language and region

**Settings → Language and region** (`Ctrl+,`, or the workspace menu) sets how dates, times and numbers look: pick your
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
- **Windows: "Windows protected your PC"** when installing: the installer isn't signed yet.
  Choose **More info**, then **Run anyway**.
- **Windows: no notifications** from automations or reminders: check **Settings → System →
  Notifications** for Workspace, and that Focus (Do not disturb) is off.
