/**
 * Twilio SIP dial-out via LiveKit.
 *
 * Flow:
 *   1. Pre-provisioned LiveKit outbound SIP trunk (created once at deploy
 *      time, see ensureSipTrunk() below) is configured with Twilio
 *      Programmable Voice credentials.
 *   2. When the chat invite endpoint receives an offline-with-phone
 *      invite, we call dialPhoneIntoRoom() which uses LiveKit's
 *      SipClient.createSipParticipant() to ask LiveKit to dial the
 *      number through Twilio and join the resulting call as a SIP
 *      participant in the LiveKit room. The phone caller appears to
 *      other participants like a normal LK participant (audio-only).
 *
 * Required env:
 *   LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_WS_URL  (already required)
 *   LIVEKIT_HOST                                          (e.g. "wss://...livekit.cloud" without "wss://")
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN                 (for the trunk)
 *   TWILIO_FROM_NUMBER                                    (E.164 caller id)
 *   LIVEKIT_SIP_TRUNK_ID                                  (optional — provisioned automatically if absent)
 */
import { SipClient } from "livekit-server-sdk";

let cachedClient: SipClient | null = null;
let cachedTrunkId: string | null = null;

function getHost(): string {
  // SipClient wants the LiveKit host as an https/wss URL. We accept either
  // LIVEKIT_HOST (preferred) or derive from LIVEKIT_WS_URL by swapping
  // wss:// for https://.
  const raw = process.env.LIVEKIT_HOST || process.env.LIVEKIT_WS_URL || "";
  if (!raw) return "";
  return raw.startsWith("wss://") ? raw.replace(/^wss:\/\//, "https://") : raw;
}

export function sipConfigured(): boolean {
  return !!(
    process.env.LIVEKIT_API_KEY &&
    process.env.LIVEKIT_API_SECRET &&
    (process.env.LIVEKIT_HOST || process.env.LIVEKIT_WS_URL) &&
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER
  );
}

function client(): SipClient {
  if (cachedClient) return cachedClient;
  cachedClient = new SipClient(
    getHost(),
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  );
  return cachedClient;
}

/**
 * Idempotently provision a Twilio SIP outbound trunk on LiveKit. We
 * cache the id in module memory; on cold-start we either reuse
 * LIVEKIT_SIP_TRUNK_ID from env, or list existing trunks and reuse the
 * one named "bulldog-twilio", or create a new one.
 */
export async function ensureSipTrunk(): Promise<string | null> {
  if (cachedTrunkId) return cachedTrunkId;
  if (!sipConfigured()) return null;

  const fromEnv = process.env.LIVEKIT_SIP_TRUNK_ID;
  if (fromEnv) {
    cachedTrunkId = fromEnv;
    return fromEnv;
  }

  const c = client();
  const TRUNK_NAME = "bulldog-twilio";
  try {
    const existing = await c.listSipOutboundTrunk();
    const match = existing.find((t: { name?: string; sipTrunkId?: string }) => t.name === TRUNK_NAME);
    if (match?.sipTrunkId) {
      cachedTrunkId = match.sipTrunkId;
      console.log(`[sip] Reusing LiveKit SIP trunk ${cachedTrunkId} (${TRUNK_NAME})`);
      return cachedTrunkId;
    }
  } catch (e) {
    console.warn("[sip] listSipOutboundTrunk failed, will try create:", e);
  }

  try {
    // Twilio outbound SIP termination URI.
    //
    // Twilio Elastic SIP Trunking endpoint format:
    //   <trunk-domain>.pstn.twilio.com  (requires an Elastic SIP Trunk
    //   provisioned in the Twilio console under Elastic SIP Trunking)
    //
    // If you only have Programmable Voice (no Elastic SIP Trunk), set
    // TWILIO_SIP_TERMINATION_URI to your Elastic SIP Trunk's termination
    // URI. The Account-SID-based `<sid>.pstn.twilio.com` form is NOT a
    // real Twilio endpoint and will fail at dial time.
    const address =
      process.env.TWILIO_SIP_TERMINATION_URI ||
      // Sensible default that at least lets LiveKit accept the trunk
      // creation request; will need TWILIO_SIP_TERMINATION_URI set for
      // actual outbound calls to bridge.
      `${process.env.TWILIO_ACCOUNT_SID}.pstn.twilio.com`;

    // SDK signature: createSipOutboundTrunk(name, address, numbers, opts)
    // — positional args, NOT a single object. We pass authUsername /
    // authPassword in opts so LiveKit can present Twilio credentials.
    const created = await c.createSipOutboundTrunk(
      TRUNK_NAME,
      address,
      [process.env.TWILIO_FROM_NUMBER!],
      {
        authUsername: process.env.TWILIO_ACCOUNT_SID!,
        authPassword: process.env.TWILIO_AUTH_TOKEN!,
        transport: 1 /* SIP_TRANSPORT_TCP — Twilio prefers TCP/TLS */,
      },
    );
    cachedTrunkId = created.sipTrunkId ?? null;
    if (cachedTrunkId) {
      console.log(`[sip] Created LiveKit SIP trunk ${cachedTrunkId} (${TRUNK_NAME}) → ${address}`);
    }
    return cachedTrunkId;
  } catch (e) {
    console.error("[sip] createSipOutboundTrunk failed:", e);
    return null;
  }
}

/**
 * Dial `phone` (E.164) into the LiveKit `roomName` as a SIP participant
 * named `displayName`. Returns the participant identity on success, or
 * null if dial-out is unavailable or fails.
 */
export async function dialPhoneIntoRoom(opts: {
  phone: string;
  roomName: string;
  displayName: string;
}): Promise<string | null> {
  if (!sipConfigured()) {
    console.warn("[sip] dialPhoneIntoRoom skipped — SIP not configured");
    return null;
  }
  const trunkId = await ensureSipTrunk();
  if (!trunkId) {
    console.warn("[sip] dialPhoneIntoRoom skipped — no SIP trunk available");
    return null;
  }
  const identity = `sip_${opts.phone.replace(/\D/g, "")}_${Date.now()}`;
  try {
    await client().createSipParticipant(
      trunkId,
      opts.phone,
      opts.roomName,
      {
        participantIdentity: identity,
        participantName: opts.displayName || opts.phone,
        // Play a short ring/announce to the called party before bridging.
        // Keeping it brief so we don't drag out connect time.
        playDialtone: true,
      },
    );
    console.log(`[sip] Dialed ${opts.phone} → room ${opts.roomName} as ${identity}`);
    return identity;
  } catch (e) {
    console.error(`[sip] createSipParticipant failed for ${opts.phone} → ${opts.roomName}:`, e);
    return null;
  }
}
