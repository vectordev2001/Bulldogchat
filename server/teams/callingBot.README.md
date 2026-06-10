# Teams Calling Bot — Layer 4 (deferred)

This is a **placeholder**. No calling-bot code ships in Phase 2.1. This file
documents what a future media-bridging bot would do and why it was deferred.

## What it would do

Join a scheduled Teams meeting as a participant (a "bot") and bridge real-time
audio/video between the Teams meeting and the Bulldog LiveKit room. The result
would be a **single unified room**: Bulldog users and Teams users could see and
hear each other live, instead of being in two separate calls that happen to
share a title.

Pipeline sketch:

1. When a scheduled call with a `teamsJoinUrl` starts, signal the bot service.
2. The bot answers/joins the Teams meeting via the Microsoft Bot Framework +
   the Real-time Media Platform (Application-hosted media).
3. The bot subscribes to Teams participants' audio/video and republishes it
   into the LiveKit room (`call.roomName`), and vice-versa.
4. On call end, the bot leaves both rooms and tears down media.

## What it needs

- A **separate Node.js (or .NET) service** — the media SDK runs a long-lived
  media session and is not appropriate for the request/response chat server.
- A **public HTTPS webhook endpoint** for Bot Framework calling notifications
  (incoming call / call state callbacks).
- An **Azure Bot Channels Registration** (or Azure Bot resource) wired to the
  existing "Bulldog Chat Teams Connector" app registration, with the calling
  webhook configured and the `Calls.*` application permissions (already granted:
  `Calls.JoinGroupCall.All`, `Calls.JoinGroupCallAsGuest.All`,
  `Calls.InitiateGroupCall.All`, `Calls.AccessMedia.All`).
- A media-capable host (the real-time media SDK has specific OS/runtime
  requirements and cannot run on arbitrary serverless platforms).

## Why deferred

Most users will simply click whichever join link fits their setup — Bulldog or
Teams — directly from the invite email. That covers the v1 goal (give Teams
users a native way in) with zero additional infrastructure.

Media bridging only becomes valuable if we want a **unified room** where the two
populations hear each other in real time. That is a meaningful step up in
operational and engineering cost, so it waits until there's demonstrated demand.

## Estimated complexity: HIGH

- Separate service + separate deployment + separate scaling story.
- Additional Azure setup (Bot resource, calling webhook, possibly a dedicated
  media host).
- The official Real-time Media Platform SDK is **C#/.NET only**. Node.js
  community ports exist but are less mature and less stable, so a robust
  implementation likely means introducing a .NET service into the stack.
