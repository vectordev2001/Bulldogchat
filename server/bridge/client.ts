/**
 * Bulldog Bridge HTTP client.
 *
 * The bulldog-bridge service (bridge.bulldogops.com, .NET 8 on Azure
 * Container Apps) is the orchestrator that dispatches a MediaWorker bot
 * into a Teams meeting and attaches it to the LiveKit room. From
 * Bulldogchat's perspective the bridge is a black box exposing three
 * endpoints: dispatch, status, delete.
 *
 * All operations are fail-open: if the bridge isn't configured
 * (env vars unset) or returns an error, the helpers return null/false
 * and we log a warning. The meeting still works without the bridge —
 * Bulldog users join LiveKit, Teams users join Teams via the join URL,
 * just as two parallel rooms. This is Phase 0 behavior; Phase 2 enables
 * unified audio/video once admin consent + LiveKit Opus publisher land.
 *
 * Spec: /home/user/workspace/teams-bridge-spec.md §4
 */

const BRIDGE_URL = (process.env.BULLDOG_BRIDGE_URL ?? "").replace(/\/+$/, "");
const BRIDGE_SECRET = process.env.BULLDOG_BRIDGE_SECRET ?? "";

/** True iff the bridge HTTP endpoint is configured. */
export function bridgeAvailable(): boolean {
  return !!BRIDGE_URL && !!BRIDGE_SECRET;
}

export type BridgeAudioMode = "duplex" | "teams-to-lk-only" | "lk-to-teams-only";

export interface DispatchBridgeInput {
  meetingId: string;
  teamsJoinUrl: string;
  teamsMeetingId: string;
  livekitRoom: string;
  livekitToken: string;
  livekitWsUrl: string;
  organizerId?: string | null;
  displayName?: string;
  options?: {
    audioMode?: BridgeAudioMode;
    videoMode?: BridgeAudioMode;
    screenShareMode?: BridgeAudioMode;
    recordOnTeamsSide?: boolean;
    announceOnJoin?: boolean;
    maxDurationMinutes?: number;
  };
}

export interface BridgeDispatchResult {
  bridgeId: string;
  status: string;
  createdAt: string;
}

export interface BridgeStatus {
  bridgeId: string;
  meetingId: string;
  status: string;
  teamsParticipantCount?: number;
  livekitParticipantCount?: number;
  joinedAt?: string;
  lastError?: string | null;
  mediaHealth?: {
    audioFlowing?: boolean;
    videoFlowing?: boolean;
    lastMediaFrameAt?: string;
  };
}

/**
 * POST /bridges — ask the bridge to dispatch a bot into the Teams meeting
 * and have it join the LiveKit room as `Bulldog Bridge (recording)`.
 *
 * Returns null if the bridge isn't configured or the call failed; in
 * either case Bulldogchat falls back to "two parallel rooms" UX, where
 * Bulldog users join LiveKit and Teams users join Teams independently.
 */
export async function dispatchBridge(
  input: DispatchBridgeInput,
): Promise<BridgeDispatchResult | null> {
  if (!bridgeAvailable()) {
    console.warn("[bridge] dispatchBridge: BULLDOG_BRIDGE_URL/SECRET not configured — skipping");
    return null;
  }
  try {
    const res = await fetch(`${BRIDGE_URL}/bridges`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BRIDGE_SECRET}`,
      },
      body: JSON.stringify({
        meetingId: input.meetingId,
        teamsJoinUrl: input.teamsJoinUrl,
        teamsMeetingId: input.teamsMeetingId,
        livekitRoom: input.livekitRoom,
        livekitToken: input.livekitToken,
        livekitWsUrl: input.livekitWsUrl,
        organizerId: input.organizerId ?? null,
        displayName: input.displayName ?? "Bulldog Bridge (recording)",
        options: {
          audioMode: input.options?.audioMode ?? "duplex",
          videoMode: input.options?.videoMode ?? "duplex",
          screenShareMode: input.options?.screenShareMode ?? "duplex",
          recordOnTeamsSide: input.options?.recordOnTeamsSide ?? false,
          announceOnJoin: input.options?.announceOnJoin ?? true,
          maxDurationMinutes: input.options?.maxDurationMinutes ?? 240,
        },
      }),
      // Render egress can take a beat on cold start; give the bridge
      // 10s to accept the dispatch (it returns immediately once queued).
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[bridge] dispatchBridge non-2xx: ${res.status} ${body.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as BridgeDispatchResult;
    if (!data?.bridgeId) {
      console.warn("[bridge] dispatchBridge: response missing bridgeId");
      return null;
    }
    return data;
  } catch (err) {
    console.warn("[bridge] dispatchBridge threw:", (err as Error).message);
    return null;
  }
}

/**
 * GET /bridges/:bridgeId — used by background pollers and the in-room
 * "Reconnect bridge" button when the webhook stream is lossy.
 */
export async function getBridgeStatus(bridgeId: string): Promise<BridgeStatus | null> {
  if (!bridgeAvailable()) return null;
  try {
    const res = await fetch(`${BRIDGE_URL}/bridges/${encodeURIComponent(bridgeId)}`, {
      headers: { Authorization: `Bearer ${BRIDGE_SECRET}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as BridgeStatus;
  } catch {
    return null;
  }
}

/**
 * DELETE /bridges/:bridgeId — graceful disconnect. Called when the
 * LiveKit room empties or the meeting is explicitly ended.
 */
export async function deleteBridge(bridgeId: string): Promise<boolean> {
  if (!bridgeAvailable()) return false;
  try {
    const res = await fetch(`${BRIDGE_URL}/bridges/${encodeURIComponent(bridgeId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${BRIDGE_SECRET}` },
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Constant-time bridge-webhook authentication. The bridge sends events to
 * POST /internal/bridge-events with `Authorization: Bearer <secret>`.
 */
export function verifyBridgeWebhookSecret(authHeader: string | undefined): boolean {
  if (!BRIDGE_SECRET) return false;
  if (!authHeader) return false;
  const expected = `Bearer ${BRIDGE_SECRET}`;
  if (authHeader.length !== expected.length) return false;
  // Constant-time compare to avoid leaking the secret length via timing.
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ authHeader.charCodeAt(i);
  }
  return mismatch === 0;
}
