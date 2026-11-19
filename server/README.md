# Portal Customizer admin server

Publishes the organization layout (`/portal-customizer.json`) for the Portal Customizer extension and gives administrators a web console.
No dependencies: Node.js 18+, git and PM2.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/lisyoen/portal-customizer/main/server/scripts/install.sh | bash -s -- --port 9150 --url http://SERVER:9150
```

The script clones the repository to `~/portal-customizer-server`, checks out the latest `server-v*` release, asks for the administrator password,
starts the server with PM2 (`portal-customizer-server`) and prints the addresses. Run it again to upgrade. Data lives in `server/data/`.

## How it is used

1. An administrator installs the extension, opens the popup › **Admin login** with the server address and account.
2. They arrange the portal page in edit mode and press **Send to server** with a name.
3. In the console (`http://SERVER:9150/`) the layouts are listed. One is the **default**; others get a start and end time.
   During its period a scheduled layout is published instead of the default; when periods overlap, the one higher in the list wins.
4. Staff enter `http://SERVER:9150/portal-customizer.json` as the organization default in their popup (or administrators set it with the `orgConfigUrl` policy).

## Console

| Menu | What it does |
|------|--------------|
| Layouts | List with priority, status (default, live, upcoming, ended, draft, off), publishing period, on/off, copy, delete, a 30-day timeline of what will be shown. |
| Layout editor | Columns (width, fill, spacing) and panels (title, height, spacing, hidden, type settings). Pictures and videos can be uploaded or picked from the CMS. JSON view and change history with restore. |
| Contents (CMS) | Groups of images, videos, text, rich text (HTML) and links, with upload, tags and search. |
| Statistics | Daily users and requests, which layout was shown, extension versions (an anonymous install id is counted, no personal data). |
| Administrators | Accounts with administrator or editor role, password reset, disable, audit log. |
| Settings & update | Server address, automatic update, check for a new release, upload an offline update package, backup and restore, unused file cleanup. |

## Update

- Extensions re-check `portal-customizer.json` at the interval set on the settings page (minutes, default 5). The value is published in the file as `refreshMinutes`, so a change reaches every browser on its next check.
- Online: the server checks GitHub for `server-v*` tags (every minute by default; the interval is set in minutes on the settings page) and, when automatic update is on, checks out the new tag,
  restarts the PM2 app, verifies `/api/health` and rolls back on failure.
- Offline: download `portal-customizer-server-update-X.Y.Z.tar.gz` from the release page and upload it in **Settings & update**.

## API (for scripts)

`POST /api/login {user,password}` → `{token}`; then `Authorization: Bearer <token>`.
`GET/POST /api/layouts`, `GET/PUT/DELETE /api/layouts/:id`, `POST /api/layouts/:id/default`, `POST /api/layouts/order {ids}`,
`GET/POST/PUT/DELETE /api/contents`, `PUT /api/upload?name=file.png` (raw body), `GET /api/stats`, `GET /api/backup`.

## Development

`cd server && node --test tests/` · release: `bash server/scripts/release.sh <version> <notes.md>` (tag `server-vX.Y.Z`).

## Manual and license

The admin console has **매뉴얼** (manual) and **라이선스** (license) pages. They show [docs/manual.ko.md](../docs/manual.ko.md) and [docs/license.ko.md](../docs/license.ko.md) from this repository, so they follow each update. License: [Business Source License 1.1](../LICENSE).
