# Vector Chat

> Group text, voice, and video for Vector Services field crews.
> **Rooted in Service. Driven by Discipline.**

Vector Chat is a multi-tenant corporate communications app built for
[Vector Services](https://vectorservicesus.com) — a Service-Disabled Veteran-Owned
utility construction firm. It is a self-hosted Discord/Slack alternative
designed to ship a single Docker container to Render and run on a single
persistent disk.

## Feature highlights

- **Multi-tenant orgs** — every signup creates an isolated organization.
- **Projects → channels → messages** — text and voice channels per project.
- **Real-time** updates over Server-Sent Events (no WebSocket required).
- **JWT auth** with cookie or bearer modes, plus role-based access (admin,
  foreman, office, field, safety).
- **Invites** with shareable URLs.
- **LiveKit voice/video** with a graceful "demo mode" fallback when credentials
  aren't configured.
- **Web Push** notifications (VAPID).
- **PWA** — installable, offline shell, push subscription.
- **SQLite + Drizzle ORM** — one disk, one file, zero managed services.
- **Vector Services brand** — Navy `#191E4A`, Red `#DD403D`, Blue `#5E97FF`,
  chevron-and-stars logo, Satoshi typeface.

## Quickstart (local dev)

```bash
npm install
cp .env.example .env       # edit JWT_SECRET; LiveKit/Push are optional
npm run dev                # http://localhost:5000
```

First boot seeds the **Vector Services** demo org with:

- 8 projects (Lakewood Substation, Skagit Tap, North Bend Hardening, ...)
- 15 users across all roles
- 10 channels per project (8 text + 2 voice)

### Demo credentials

| Role        | Email                            | Password    |
| ----------- | -------------------------------- | ----------- |
| **Admin**   | `admin@vectorservicesus.com`     | `Vector2026!` |
| Crew (any)  | `<firstname>@vectorservicesus.com` | `Crew2026!` |

The login screen has a **"Use demo credentials"** shortcut.

## Deploy to Render

1. Push this repo to GitHub.
2. In Render, **New +** → **Blueprint** → select the repo.
3. Render reads `render.yaml`, creates the service, and attaches a 1 GB
   persistent disk at `/app/data` (where SQLite lives).
4. Set the optional secrets in the Render dashboard:
   - `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_WS_URL` — for voice/video.
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VITE_VAPID_PUBLIC_KEY` — for push.
5. Deploy. First boot will seed the Vector Services demo data.

`JWT_SECRET` is generated automatically by Render.

### Generate VAPID keys

```bash
npx web-push generate-vapid-keys
```

Paste the **public** key into both `VAPID_PUBLIC_KEY` and `VITE_VAPID_PUBLIC_KEY`,
the **private** key into `VAPID_PRIVATE_KEY`.

## Environment variables

See [.env.example](./.env.example) for the full list with comments.

| Variable | Required | Purpose |
| --- | --- | --- |
| `JWT_SECRET` | yes | Token signing key. |
| `DATABASE_URL` | yes | SQLite file path. `file:/app/data/vector.db` in prod. |
| `VITE_AUTH_MODE` | no | `bearer` (default) or `cookie`. |
| `LIVEKIT_API_KEY/SECRET/WS_URL` | optional | Real voice channels. Omit → demo mode. |
| `VAPID_*` + `VITE_VAPID_PUBLIC_KEY` | optional | Web push notifications. |

## Architecture

```
client/   → Vite + React + Tailwind + shadcn/ui + TanStack Query
server/   → Express + Drizzle + better-sqlite3 + JWT + SSE + LiveKit + web-push
shared/   → Drizzle schema + Zod types
script/   → esbuild bundling for production
```

- Frontend talks to backend exclusively through `apiRequest` from
  `client/src/lib/queryClient.ts`. JWT is injected via in-memory state.
- Real-time updates use `/api/events` (SSE) — no WebSocket plumbing.
- Voice channels POST to `/api/channels/:id/voice/token`; if LiveKit env vars
  are missing, the server returns `503 { preview_mode: true }` and the client
  renders a demo-mode banner with a simulated room.

## Production build

```bash
npm run build      # Vite client + esbuild server → dist/
npm start          # node dist/index.cjs
```

The Dockerfile does this in two stages and ships a small Alpine runtime.

## License

MIT
