# Teams Host View — Azure Setup Prerequisites

**Feature:** In-app Teams lobby control (Phase 1.9.5)  
**Sprint:** 1  
**Code lives in:** `feat/teams-host-view-sprint1`

This document describes the one-time Azure setup that Josh Bieler must complete before the Teams Host View feature will function. The code is already deployed; it returns a safe 501 response until these steps are done.

> **Do NOT wipe existing env vars. Add per-key only.**  
> On Render, use the per-key `PUT /v1/services/{id}/env-vars/{key}` endpoint for each of the three new keys. Never perform a collection-level write that would overwrite the full set of variables. Any change touching JWT_SECRET, DATABASE_URL, LIVEKIT_*, or other existing keys requires the confirm gate.

---

## Prerequisites Checklist

### Step 1 — Create an Azure Communication Services (ACS) resource

1. Sign in to the [Azure portal](https://portal.azure.com) as a Global Admin or Contributor on the `bulldogops.com` Azure subscription.
2. Search for **Azure Communication Services** → **Create**.
3. Settings:
   - **Resource group:** `bulldog-chat-rg` (or your existing resource group)
   - **Region:** `East US 2` (same as existing Bulldog infra)
   - **Resource name:** `bulldog-acs` (or your convention)
4. After creation, go to **Keys** in the left panel:
   - Copy **Connection String** → this becomes `ACS_CONNECTION_STRING`
   - Copy **Endpoint URL** → this becomes `VITE_ACS_ENDPOINT`
5. **Estimated cost:** ~$0.004/min per active call leg. At 1 host × 5 sessions/day × 2 min average = ~$0.04/day. Under $2/month at this scale.

---

### Step 2 — Add Teams calling permissions to the chat Entra App Registration

1. In the Azure portal, go to **Azure Active Directory → App Registrations**.
2. Find the Bulldog Chat app registration (the one whose Client ID is already used for Bulldog SSO / MS Graph calls).
3. Click **API Permissions → Add a permission**.
4. Select **Azure Communication Services** (search for it — it is a first-party Microsoft API).
5. Add **Delegated permissions**:
   - `Teams.ManageCalls`
   - `Teams.ManageChats`
6. After adding both permissions, click **Grant admin consent for bulldogops.com**.
   - This is a one-time action. After consent, users in the tenant will silently receive these permissions without an interactive consent prompt.
7. Copy the **Application (client) ID** of this app registration → this becomes `ACS_ENTRA_CLIENT_ID`.

> **Note:** These are delegated permissions on the *Azure Communication Services* API — not Microsoft Graph. Do not confuse them with Graph's `OnlineMeetings.ReadWrite` or `CallRecords.Read.All`.

---

### Step 3 — Add the three new env vars to Render (per-key only)

Log in to the [Render dashboard](https://dashboard.render.com) and navigate to the **Bulldog Chat** service. Add each key individually via **Environment → Add Environment Variable**. Do not use any bulk import or export workflow.

| Key | Value | Source |
|-----|-------|--------|
| `ACS_CONNECTION_STRING` | `endpoint=https://bulldog-acs.communication.azure.com/;accesskey=...` | Azure portal → ACS resource → Keys |
| `ACS_ENTRA_CLIENT_ID` | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | App registration → Overview |
| `VITE_ACS_ENDPOINT` | `https://bulldog-acs.communication.azure.com/` | Azure portal → ACS resource → Overview |

> **`VITE_ACS_ENDPOINT`** is a build-time Vite env var. After adding it to Render, trigger a **manual deploy** (not just a restart) so Vite picks it up during the build step.

---

### Step 4 — License check

All users who will use the "Open lobby control" button need an active **Microsoft 365 / Teams license** on their `bulldogops.com` account. This is already true for Josh and the intended hosts as of the current roster.

No action required unless new hosts are added who lack a Teams license.

---

### Step 5 — Smoke test

After completing steps 1–4 and triggering a Render deploy:

1. Josh signs into Bulldog Chat and opens a scheduled Teams meeting that is within its active window (start <= now + 30 min).
2. Clicks **Open lobby control** -> panel should transition from "Joining" to "Live — no guests waiting".
3. From a private browser tab (or a separate Quanta account), clicks **Join via Teams** on the same meeting.
4. Josh's panel shows the guest's name within ~3s.
5. Josh clicks **Admit** — the guest enters the meeting.
6. Josh clicks **Reject** on a second guest -> guest sees the standard Teams "you were not admitted" screen.

---

## Rollback / Partial Deployment

If the Azure setup is not complete, the feature degrades gracefully:

- `POST /api/teams/lobby/acs-token` returns **501 Not Implemented** with a human-readable message.
- The `LobbyControlPanel` will show an error state pointing at this document.
- All other Bulldog Chat functionality is unaffected — no env vars are removed and no existing routes are modified.

---

## Sprint 2 (next steps, not in this PR)

- ACS event webhook for push notifications when someone joins the lobby while the panel is closed.
- Auto-open panel when the host opens a meeting card and someone is already waiting.
- "Recent decisions" audit log (who admitted/rejected whom, with timestamps).
