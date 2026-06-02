/**
 * CallContext — orchestrates 1:1 ringing on the client.
 *
 * Responsibilities:
 *   - Subscribe to SSE call events (incoming, accepted, ended).
 *   - Hold UI state for the IncomingCallModal and the ActiveCallOverlay.
 *   - Expose imperative actions (startCall, accept, decline, end) so
 *     any component (chat sidebar, header, future CRM) can place a call
 *     without re-implementing the wire protocol.
 *
 * Design choice: this lives alongside the existing useSSE hook used by
 * Home.tsx for messages. The SSE server already keeps a single open
 * connection per user; we open a second EventSource here that listens
 * only for call events. Two connections per user is acceptable (the
 * SSE subscriber pool is tiny) and isolates the call concerns so the
 * messages hook doesn't have to grow.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { apiRequest, getAuthToken } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";

export interface IncomingCallData {
  callId: number;
  callerId: number;
  calleeId: number;
  callerName: string;
  callerHue: number;
  kind: "voice" | "video";
  roomName: string;
}

export interface ActiveCallSession {
  callId: number;
  roomName: string;
  token: string;
  wsUrl: string;
  otherName: string;
  otherHue: number;
  kind: "voice" | "video";
  /** Are we the original caller? Affects which "end" semantics to send. */
  iAmCaller: boolean;
  /** Set true once both sides have joined the room. */
  active: boolean;
}

export interface OutgoingCallState {
  callId: number;
  calleeName: string;
  calleeHue: number;
  kind: "voice" | "video";
}

interface CallCtxValue {
  /** Set when there's an incoming ringing call this user can pick up. */
  incoming: IncomingCallData | null;
  /** Set while we're calling someone and waiting for them to pick up. */
  outgoing: OutgoingCallState | null;
  /** Set once a call (incoming or outgoing) has been accepted. */
  active: ActiveCallSession | null;
  /** Last call we missed/declined — used for a brief toast. */
  lastEnded: { reason: "declined" | "missed" | "ended"; otherName: string } | null;

  startCall(opts: { calleeId: number; calleeName: string; calleeHue: number; kind?: "voice" | "video" }): Promise<void>;
  /**
   * Start a group call from a text channel. Server rings every invitee
   * with the same shared LiveKit room name; the caller is dropped into
   * that room immediately (no "calling…" wait state — invitees can
   * trickle in as they accept).
   */
  startGroupCall(opts: {
    channelId: number;
    channelName: string;
    /** Chat user IDs to ring via in-app push (LiveKit). */
    inviteeIds: number[];
    /** Chat user IDs to ring via their saved cell phone. Server looks
     *  up the phone from the user record and bridges through Twilio. */
    phoneInviteeIds?: number[];
    /** Raw phone numbers (E.164 or US digits) to phone-bridge into the
     *  room. SIP From is branded as "Bulldog · #channel". */
    phoneNumbers?: string[];
    kind?: "voice" | "video";
  }): Promise<void>;
  acceptIncoming(): Promise<void>;
  declineIncoming(): Promise<void>;
  endActive(): Promise<void>;
  cancelOutgoing(): Promise<void>;
  clearLastEnded(): void;
}

const CallCtx = createContext<CallCtxValue | null>(null);

export function useCalls(): CallCtxValue {
  const v = useContext(CallCtx);
  if (!v) throw new Error("useCalls() must be used inside <CallProvider>");
  return v;
}

interface StartCallResponse {
  callId: number;
  roomName: string;
  token: string;
  ws_url: string;
}

interface StartGroupCallResponse {
  roomName: string;
  token: string;
  ws_url: string;
  invitedUserIds: number[];
  kind: "voice" | "video";
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();

  const [incoming, setIncoming] = useState<IncomingCallData | null>(null);
  const [outgoing, setOutgoing] = useState<OutgoingCallState | null>(null);
  const [active, setActive] = useState<ActiveCallSession | null>(null);
  const [lastEnded, setLastEnded] = useState<{ reason: "declined" | "missed" | "ended"; otherName: string } | null>(null);

  // Refs let SSE handlers (which capture stale state) access the
  // latest values without re-binding listeners every render.
  const incomingRef = useRef(incoming); incomingRef.current = incoming;
  const outgoingRef = useRef(outgoing); outgoingRef.current = outgoing;
  const activeRef = useRef(active); activeRef.current = active;

  // Ringtone: a short looping web-audio beep. We can't play <audio src>
  // for arbitrary domains without bundling one, and a synthetic tone
  // keeps the bundle small. Browsers only allow this after a gesture;
  // since the user must have interacted with chat to get here, that's
  // usually fine. We still handle the rejected play() Promise.
  const ringAudioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    // A minimal data URI \u2014 phone-style ring (a couple of sine bursts).
    const a = new Audio(RING_TONE_DATA_URI);
    a.loop = true;
    ringAudioRef.current = a;
    return () => { a.pause(); ringAudioRef.current = null; };
  }, []);

  const playRing = useCallback(() => {
    ringAudioRef.current?.play().catch(() => { /* browser blocked autoplay; ignore */ });
  }, []);
  const stopRing = useCallback(() => {
    if (ringAudioRef.current) {
      ringAudioRef.current.pause();
      ringAudioRef.current.currentTime = 0;
    }
  }, []);

  // SSE for call events. Opens when a user is signed in; closes on
  // logout. We piggyback on the same token auth as useSSE() so we get
  // the same identity guarantee.
  useEffect(() => {
    if (!user) return;
    const token = getAuthToken();
    const url = `/api/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    let es: EventSource | null = null;
    try {
      es = new EventSource(url, { withCredentials: true });
    } catch {
      return;
    }

    const onIncoming = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as IncomingCallData;
        // Ignore self-ringing edge cases.
        if (data.calleeId !== user.id) return;
        // If we're already in an active call, auto-decline the new one.
        if (activeRef.current) {
          apiRequest("POST", `/api/calls/${data.callId}/end`, { action: "decline" }).catch(() => {});
          return;
        }
        setIncoming(data);
        playRing();
      } catch { /* ignore */ }
    };

    const onAccepted = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        // If we were the caller, fetch our token by re-querying the
        // call. The server already minted one when the row was created,
        // but the simplest path is to just call GET /api/calls/:id and
        // get a fresh token + ws_url.
        const out = outgoingRef.current;
        if (out && out.callId === data.callId) {
          // Stop the outgoing ring sound and transition to active.
          stopRing();
          void (async () => {
            const detail = await apiRequest<any>("GET", `/api/calls/${data.callId}`);
            if (!detail?.token) return;
            setOutgoing(null);
            setActive({
              callId: data.callId,
              roomName: detail.call.roomName,
              token: detail.token,
              wsUrl: detail.ws_url,
              otherName: detail.other?.name ?? out.calleeName,
              otherHue: detail.other?.hue ?? out.calleeHue,
              kind: out.kind,
              iAmCaller: true,
              active: true,
            });
          })();
        }
      } catch { /* ignore */ }
    };

    const onEnded = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as IncomingCallData & { reason: "declined" | "missed" | "ended" };
        stopRing();

        // If we have a matching outgoing or incoming call, clear it.
        if (incomingRef.current?.callId === data.callId) {
          setIncoming(null);
          setLastEnded({ reason: data.reason, otherName: data.callerName });
        }
        if (outgoingRef.current?.callId === data.callId) {
          setOutgoing(null);
          // For caller, only show the "missed/declined" toast \u2014 not on end.
          if (data.reason === "missed" || data.reason === "declined") {
            const out = outgoingRef.current;
            setLastEnded({ reason: data.reason, otherName: out.calleeName });
          }
        }
        if (activeRef.current?.callId === data.callId) {
          setActive(null);
        }
      } catch { /* ignore */ }
    };

    es.addEventListener("call:incoming", onIncoming);
    es.addEventListener("call:outgoing", () => { /* server confirmation; nothing to do here */ });
    es.addEventListener("call:accepted", onAccepted);
    es.addEventListener("call:ended", onEnded);

    return () => {
      es?.close();
      stopRing();
    };
    // We only care about user identity changing here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Imperative actions exposed to consumers.
  const startCall = useCallback<CallCtxValue["startCall"]>(async ({ calleeId, calleeName, calleeHue, kind = "voice" }) => {
    if (outgoing || active) return;
    const resp = await apiRequest<StartCallResponse>("POST", "/api/calls/start", { calleeId, kind });
    setOutgoing({ callId: resp.callId, calleeName, calleeHue, kind });
    playRing();
    // We keep the token in the outgoing state implicitly; once the
    // callee accepts (call:accepted SSE), we transition to active and
    // re-fetch a fresh token. We do NOT auto-join the LiveKit room
    // before acceptance \u2014 there'd be one-way audio bleed.
  }, [outgoing, active, playRing]);

  // Group call from a text channel. Server creates one direct_call row
  // per invitee (all pointing at the same room) and rings them. The caller
  // joins the LiveKit room immediately so they don't sit on a "calling…"
  // screen while waiting for the first accept.
  const startGroupCall = useCallback<CallCtxValue["startGroupCall"]>(async ({
    channelId, channelName, inviteeIds, phoneInviteeIds = [], phoneNumbers = [], kind = "voice",
  }) => {
    if (outgoing || active) return;
    const resp = await apiRequest<StartGroupCallResponse>(
      "POST", `/api/channels/${channelId}/group-call/start`,
      { inviteeIds, phoneInviteeIds, phoneNumbers, kind },
    );
    setActive({
      // No single callId for a group call — we use 0 as a sentinel and
      // skip /api/calls/:id/end on hangup (per-invitee rows are cleaned
      // up server-side as they accept/miss).
      callId: 0,
      roomName: resp.roomName,
      token: resp.token,
      wsUrl: resp.ws_url,
      otherName: `#${channelName}`,
      otherHue: 215, // neutral channel hue
      kind: resp.kind,
      iAmCaller: true,
      active: true,
    });
  }, [outgoing, active]);

  const acceptIncoming = useCallback(async () => {
    const inc = incomingRef.current;
    if (!inc) return;
    stopRing();
    const resp = await apiRequest<{ callId: number; roomName: string; token: string; ws_url: string }>(
      "POST", `/api/calls/${inc.callId}/accept`,
    );
    setIncoming(null);
    setActive({
      callId: resp.callId,
      roomName: resp.roomName,
      token: resp.token,
      wsUrl: resp.ws_url,
      otherName: inc.callerName,
      otherHue: inc.callerHue,
      kind: inc.kind,
      iAmCaller: false,
      active: true,
    });
  }, [stopRing]);

  const declineIncoming = useCallback(async () => {
    const inc = incomingRef.current;
    if (!inc) return;
    stopRing();
    setIncoming(null);
    await apiRequest("POST", `/api/calls/${inc.callId}/end`, { action: "decline" });
  }, [stopRing]);

  const cancelOutgoing = useCallback(async () => {
    const out = outgoingRef.current;
    if (!out) return;
    stopRing();
    setOutgoing(null);
    await apiRequest("POST", `/api/calls/${out.callId}/end`, { action: "end" });
  }, [stopRing]);

  const endActive = useCallback(async () => {
    const cur = activeRef.current;
    if (!cur) return;
    setActive(null);
    // Group calls have no single callId — just drop locally; per-invitee
    // rows clean up as participants leave their own LiveKit sessions.
    if (cur.callId === 0) return;
    await apiRequest("POST", `/api/calls/${cur.callId}/end`, { action: "end" });
  }, []);

  const clearLastEnded = useCallback(() => setLastEnded(null), []);

  return (
    <CallCtx.Provider value={{
      incoming, outgoing, active, lastEnded,
      startCall, startGroupCall, acceptIncoming, declineIncoming, endActive, cancelOutgoing, clearLastEnded,
    }}>
      {children}
    </CallCtx.Provider>
  );
}

/**
 * A short data-URI ringtone (about half a second of 880Hz on/off bursts).
 * Generated offline so we don't ship a real mp3. The browser loops it.
 * If decoding fails (very old browser), playRing() silently no-ops \u2014
 * the visual modal still appears.
 */
// 100ms 880Hz square wave repeated; small wav header in base64.
// Kept as a string constant to avoid an extra fetch.
const RING_TONE_DATA_URI = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";
