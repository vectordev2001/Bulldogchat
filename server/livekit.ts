import { AccessToken } from "livekit-server-sdk";

export function livekitConfigured(): boolean {
  return !!(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET && process.env.LIVEKIT_WS_URL);
}

export async function generateLivekitToken(opts: {
  userId: number;
  userName: string;
  roomName: string;
  canPublish?: boolean;
}): Promise<string> {
  const apiKey = process.env.LIVEKIT_API_KEY!;
  const apiSecret = process.env.LIVEKIT_API_SECRET!;

  const at = new AccessToken(apiKey, apiSecret, {
    identity: `u_${opts.userId}`,
    name: opts.userName,
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
