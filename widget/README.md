# @bulldog/chat-widget

Floating cross-app mini-chat widget. Built from `bulldog-chat-repo/widget/`
and consumed by Bulldog Contracts and Bulldog Ops so users can send/receive
DMs without leaving those apps.

## Install

**Preferred (once published to GitHub Packages):**

```bash
npm install @bulldog/chat-widget
```

Requires a `.npmrc` pointing at the GitHub Packages registry for the
`@bulldog` scope:

```
@bulldog:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

**Fallback (current state — see PR notes):** consumed via a `file:` path
dependency pointing at this built package until GitHub Packages publish is
wired into CI:

```json
{
  "dependencies": {
    "@bulldog/chat-widget": "file:../bulldog-chat-repo/widget"
  }
}
```

Run `npm run build` in `widget/` first so `dist/` exists, then `npm install`
in the consumer repo.

## Usage

```tsx
import { BulldogChatWidget } from "@bulldog/chat-widget";
import "@bulldog/chat-widget/dist/style.css";

function App() {
  return (
    <>
      {/* ...routes... */}
      <BulldogChatWidget apiBaseUrl="https://chat.bulldogops.com" />
    </>
  );
}
```

## Behavior

- Fixed bottom-right pill (56×56) with unread badge; expands to a 380×560px
  panel (full-screen below 768px viewport width).
- Header shows the active conversation's title (or participant list),
  minimize/close buttons.
- Sidebar drawer (hamburger icon) lists your DMs; click to switch.
- `Esc` collapses the panel. `Cmd/Ctrl + /` toggles it open/closed.
- Authenticates via the shared Bulldog Auth JWT cookie
  (`Domain=.bulldogops.com`) — no separate login. If the cookie isn't valid,
  the widget still renders the pill but shows a "sign in on Chat" message
  inside the panel instead of erroring.
- Subscribes to the same SSE stream as the main Chat app
  (`GET {apiBaseUrl}/api/events`), so new messages/renames/new DMs show up
  live.
- Syncs "active conversation" with the main Chat app tab (and other widget
  instances) on the **same origin** via `BroadcastChannel("bulldog-chat-sync")`,
  and persists the last-opened conversation to `localStorage` so a page
  reload reopens the same thread. Note: BroadcastChannel is same-origin only,
  so a Contracts tab and an Ops tab do not mirror each other directly — each
  independently restores its own last conversation from localStorage and
  stays live via SSE.

## Cross-origin requirements

Chat's API must have CORS configured to allow the calling origin with
credentials. See `server/index.ts` / `CORS_ALLOWED_ORIGINS` in
`bulldog-chat-repo`. The Bulldog Auth cookie must be
`Domain=.bulldogops.com; SameSite=Lax; Secure` so it's readable across
`chat.`, `contracts.`, and `ops.` subdomains.

## Build

```bash
npm install
npm run build     # tsup (ESM+CJS+d.ts) + tailwind CSS bundle -> dist/
npm run check     # tsc --noEmit
npm run test       # node:test smoke tests
```

Styling ships as a compiled CSS bundle (`dist/style.css`) built from a
scoped Tailwind config (`bcw-` prefix, `preflight` disabled) — see
`tailwind.config.js`. Consumers do not need Tailwind configured themselves;
just import the stylesheet once.
