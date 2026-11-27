# Workspace's own Google client (for the maintainers)

Workspace and Workspace Calendar can sign in to Google with a client of their own, built into
the packages CI makes, so people only click **Sign in with Google**. Without it, each person has
to make a Google Cloud project and paste its client into Settings (they still can, to use their
own). This page is the one-time setup of that client, and getting it verified by Google.

**What the apps ask Google for:**

| App                | Scopes                                                                                            | Google's class                 |
| ------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------ |
| Workspace Calendar | `openid`, `email`, `calendar.calendarlist.readonly`, `calendar.events`                            | **sensitive**: needs verifying |
| Workspace          | `openid`, `email`, `drive.file` (only the files the person picks), and the Picker with an API key | not sensitive                  |

Sensitive scopes need Google's verification before anyone outside your test users can sign in.
Neither app asks for a _restricted_ scope, so no security assessment is needed.

## 1. The project and the client

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (for
   example "Workspace apps"). Note its **project number** (Dashboard → Project info).
2. **APIs & Services → Library:** enable the **Google Calendar API**, the **Google Drive API**
   and the **Google Picker API**.
3. **Google Auth Platform → Branding** (the OAuth consent screen):
   - App name: Workspace. User support email and developer contact: yours.
   - App logo: `apps/desktop/build/icon.png` (Google reviews it).
   - App home page: the project's site, for example `https://ariehant.github.io/workspace/`.
   - Privacy policy: `https://ariehant.github.io/workspace/privacy` (step 3 publishes
     [PRIVACY.md](../PRIVACY.md) there).
   - Authorized domains: `ariehant.github.io` (or your own domain).
4. **Audience:** External. While it's in **Testing**, only the test users you add can sign in
   (at most 100) and their sign-ins end after 7 days.
5. **Data access:** add the scopes in the table above.
6. **Clients → Create client**, type **Desktop app**, name "Workspace desktop". Note the
   **client ID** and **client secret**. A desktop client's secret isn't a secret (every installed
   copy has it; Google says so), and both apps sign in with PKCE.
7. **APIs & Services → Credentials → Create credentials → API key** for the Picker. Restrict it
   to the **Google Picker API**.

## 2. Into the builds

In GitHub, **Settings → Secrets and variables → Actions → New repository secret**, add:

| Secret                  | Value                                          |
| ----------------------- | ---------------------------------------------- |
| `GOOGLE_CLIENT_ID`      | the client ID (`….apps.googleusercontent.com`) |
| `GOOGLE_CLIENT_SECRET`  | the client secret                              |
| `GOOGLE_API_KEY`        | the Picker's API key                           |
| `GOOGLE_PROJECT_NUMBER` | the project number                             |

The package jobs in CI and the Release workflow pass them to the build (`electron.vite.config.ts`
in each app), so the next `latest-build` and the next release have the client. Builds without
the secrets (a fork, a local `pnpm package`) work as before: people set up their own client.
For a local build with the client, set the same variables in the environment.

## 3. Verification

Google verifies sensitive scopes before it lets anyone sign in. It takes from a few days to a
few weeks, and Google may write back with questions.

1. **A home page and the privacy policy on a domain you own.** GitHub Pages works: publish
   [PRIVACY.md](../PRIVACY.md) as `/privacy` and a short home page (what the apps are, a link to
   the repository and to the privacy policy) on the `gh-pages` branch, then verify the domain in
   [Google Search Console](https://search.google.com/search-console) with the same Google account.
2. **A demo video** (unlisted on YouTube) showing, in English: the consent screen with the app's
   name and the scopes; then Workspace Calendar using them: the calendars listed, an event shown,
   one created and moved, and changed in Google Calendar too.
3. **Justification for each sensitive scope**, for the form:
   - `calendar.calendarlist.readonly`: "Workspace Calendar is a desktop calendar. It lists the
     user's Google calendars so they can choose which to show beside their other calendars."
   - `calendar.events`: "The user views, creates, moves, edits and deletes events of the calendars
     they chose, from the desktop app. Events are kept on the user's computer only, to work
     offline; nothing is sent to us or anyone else."
4. **Google Auth Platform → Verification center → Prepare for verification**, fill in the form
   with the above, and submit. Then set the audience to **In production**.

Until it's verified, the client works for the test users you add (step 1.4). Google shows an
"unverified app" warning to anyone else, and lets at most 100 people sign in.

## When the client changes

A sign-in belongs to the client it was made with. People signed in with an old client are asked
to sign in again (the apps say so). Keep the same client across releases.
