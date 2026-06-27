import { AccessToken, RoomServiceClient } from "livekit-server-sdk";

export function livekitConfigured(): boolean {
  return !!(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET && process.env.LIVEKIT_WS_URL);
}

export async function generateLivekitToken(opts: {
  userId: number;
  userName: string;
  roomName: string;
  canPublish?: boolean;
}): Promise<string> {
  return mintLivekitToken({
    identity: `u_${opts.userId}`,
    name: opts.userName,
    roomName: opts.roomName,
    canPublish: opts.canPublish,
  });
}

/**
 * Low-level token minter that accepts a raw participant identity. Used for the
 * unified meetings model where a participant may be a guest (`g_<nanoid>`) with
 * no numeric chat userId. Authed callers should keep using
 * generateLivekitToken so the `u_<userId>` convention stays in one place.
 */
export async function mintLivekitToken(opts: {
  identity: string;
  name: string;
  roomName: string;
  canPublish?: boolean;
}): Promise<string> {
  const apiKey = process.env.LIVEKIT_API_KEY!;
  const apiSecret = process.env.LIVEKIT_API_SECRET!;

  const at = new AccessToken(apiKey, apiSecret, {
    identity: opts.identity,
    name: opts.name,
    ttl: 60 * 60 * 6, // 6 hours
  });
  at.addGrant({
    roomJoin: true,
    room: opts.roomName,
    canPublish: opts.canPublish ?? true,
    canSubscribe: true,
    canPublishData: true,
    // Lets the client call room.localParticipant.setAttributes() — used
    // for hand-raise (handRaised attribute propagates via
    // ParticipantAttributesChanged). Without this, setAttributes is
    // silently rejected server-side and nobody else sees the hand.
    canUpdateOwnMetadata: true,
  });
  return at.toJwt();
}

/**
 * Return the participant identities currently in `roomName`. Used by the
 * Phase 1.9 dial-absent flow to figure out which channel members haven't
 * joined the live room and therefore need their phone rung. Identities
 * follow the `u_<userId>` convention from generateLivekitToken; phone
 * participants land under `sip_<digits>_<ts>`.
 *
 * Returns an empty array when LiveKit is not configured or the room does
 * not exist yet (LiveKit creates rooms on first join).
 */
let cachedRoomService: RoomServiceClient | null = null;
function roomService(): RoomServiceClient | null {
  if (!livekitConfigured()) return null;
  if (cachedRoomService) return cachedRoomService;
  // RoomServiceClient takes the HTTP url, not the ws url. Convert
  // wss://host → https://host (and ws:// → http://) so existing
  // LIVEKIT_WS_URL env vars work without a separate variable.
  const ws = process.env.LIVEKIT_WS_URL!;
  const http = ws.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
  cachedRoomService = new RoomServiceClient(
    http,
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  );
  return cachedRoomService;
}

export async function listRoomParticipantIdentities(roomName: string): Promise<string[]> {
  const svc = roomService();
  if (!svc) return [];
  try {
    const list = await svc.listParticipants(roomName);
    return list.map(p => p.identity);
  } catch (e: unknown) {
    // LiveKit returns 404-style errors when the room is empty/not yet created.
    // Treat that as "no one in the room" rather than a hard failure.
    const msg = (e as { message?: string })?.message ?? "";
    if (msg.includes("not found") || msg.includes("NotFound")) return [];
    console.warn(`[livekit] listParticipants(${roomName}) failed:`, e);
    return [];
  }
}

/**
 * Debug helper for the "N tiles for 1 user" investigation. Returns the
 * full participant list with track publication summaries so we can see
 * directly whether the SFU is reporting (a) N distinct participants with
 * identical identity, (b) one participant with N camera publications, or
 * (c) one participant + one publication (in which case the bug is
 * entirely client-side rendering).
 */
export async function describeRoomParticipants(roomName: string): Promise<Array<{
  identity: string;
  name?: string;
  sid: string;
  joinedAt?: number;
  state?: string;
  tracks: Array<{ sid: string; source: string; type: string; muted: boolean; name?: string }>;
}>> {
  const svc = roomService();
  if (!svc) return [];
  try {
    const list = await svc.listParticipants(roomName);
    return list.map(p => ({
      identity: p.identity,
      name: p.name,
      sid: p.sid,
      joinedAt: typeof p.joinedAt === "bigint" ? Number(p.joinedAt) : (p.joinedAt as number | undefined),
      state: String(p.state ?? ""),
      tracks: (p.tracks ?? []).map((t: { sid: string; source?: unknown; type?: unknown; muted?: boolean; name?: string }) => ({
        sid: t.sid,
        source: String(t.source ?? ""),
        type: String(t.type ?? ""),
        muted: !!t.muted,
        name: t.name,
      })),
    }));
  } catch (e: unknown) {
    const msg = (e as { message?: string })?.message ?? "";
    if (msg.includes("not found") || msg.includes("NotFound")) return [];
    console.warn(`[livekit] describeRoomParticipants(${roomName}) failed:`, e);
    return [];
  }
}

/**
 * Evict any existing LiveKit participant with the given identity from the
 * room. This is the cleanup half of "identity uniqueness" — LiveKit will
 * normally boot a prior connection when a new one with the same identity
 * connects, but if the previous tab/window closed uncleanly (the WebSocket
 * never sent a graceful disconnect), the SFU can keep ghost publishers in
 * the room until its own timeout fires. Result on the user side: 1 real
 * user shows up as 5–6 tiles. We call this right before minting a fresh
 * token so the join path is idempotent and self-healing.
 *
 * Best-effort: any error (room not found, participant not present, network
 * blip) is swallowed because the subsequent connect still works — we just
 * lose the proactive cleanup for that one join.
 */
export async function evictParticipant(roomName: string, identity: string): Promise<void> {
  const svc = roomService();
  if (!svc) return;
  try {
    await svc.removeParticipant(roomName, identity);
    // eslint-disable-next-line no-console
    console.log(`[livekit] evicted stale participant ${identity} from ${roomName}`);
  } catch (e: unknown) {
    const msg = (e as { message?: string })?.message ?? "";
    // "not found" = room or participant doesn't exist, which is the
    // desired post-state anyway. Don't log noise.
    if (msg.includes("not found") || msg.includes("NotFound") || msg.includes("participant does not exist")) {
      return;
    }
    console.warn(`[livekit] removeParticipant(${roomName}, ${identity}) failed:`, e);
  }
}
