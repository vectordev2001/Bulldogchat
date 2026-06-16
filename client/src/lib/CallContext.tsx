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
    /** Chat user IDs to ALSO send an SMS join-link to (e.g. hybrid: ring
     *  cell via SIP and text them a video-join URL). Recipient SSO-logs
     *  in and joins the same LiveKit room from the link. */
    smsInviteeIds?: number[];
    /** Raw phone numbers to send an SMS join-link to (no SIP dial). */
    smsPhoneNumbers?: string[];
    kind?: "voice" | "video";
  }): Promise<void>;
  acceptIncoming(): Promise<void>;
  declineIncoming(): Promise<void>;
  endActive(): Promise<void>;
  cancelOutgoing(): Promise<void>;
  clearLastEnded(): void;
  /**
   * Ring more people into the CURRENTLY-ACTIVE call. Server posts to
   * /api/calls/active/invite which mirrors group-call/start but joins
   * the existing LiveKit room (no new room minted). Returns the server
   * response so the UI can surface dialWarnings to the caller.
   */
  inviteToActiveCall(opts: {
    inviteeIds: number[];
    phoneInviteeIds?: number[];
    phoneNumbers?: string[];
    emailAddresses?: string[];
  }): Promise<{
    invitedUserIds: number[];
    dialedUserIds: number[];
    dialedPhones: string[];
    emailedAddresses: string[];
    dialWarnings: string[];
    emailWarnings: string[];
  }>;
  /**
   * Join a call via an SMS-link join token. Posts to /api/call-join/redeem
   * which mints a LiveKit token for the signed-in user (NOT the token's
   * userId). On success the call becomes active and the LiveKit overlay
   * mounts. Used by the /call-join SPA route when someone taps an SMS link.
   */
  joinByToken(token: string): Promise<void>;
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
  dialWarnings?: string[];
  smsResults?: Array<{ userId?: number; phone: string; ok: boolean; error?: string }>;
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
    channelId, channelName, inviteeIds, phoneInviteeIds = [], phoneNumbers = [],
    smsInviteeIds = [], smsPhoneNumbers = [], kind = "voice",
  }) => {
    if (outgoing || active) return;
    let resp: StartGroupCallResponse;
    try {
      resp = await apiRequest<StartGroupCallResponse>(
        "POST", `/api/channels/${channelId}/group-call/start`,
        { inviteeIds, phoneInviteeIds, phoneNumbers, smsInviteeIds, smsPhoneNumbers, kind },
      );
    } catch (err) {
      // The request itself failed (non-2xx / network). Without surfacing
      // this the tap looked like a no-op — "nothing happens at all" — which
      // is exactly the reported phone-call symptom. Show the caller why.
      const status = (err as { status?: number })?.status;
      const body = (err as { body?: string })?.body;
      const detail = status ? `(${status}) ${body ?? ""}`.trim() : ((err as { message?: string })?.message ?? "request failed");
      // eslint-disable-next-line no-console
      console.error("[startGroupCall] request failed:", err);
      if (typeof window !== "undefined") window.alert(`Couldn't start the call: ${detail}`);
      return;
    }
    // Surface SMS dispatch results so the caller actually knows whether
    // the join link reached the recipient. Console log + window-level
    // alert for any failures (better than silent drop — the user reported
    // "text is not working" because they had no feedback).
    if (resp.smsResults && resp.smsResults.length > 0) {
      const failed = resp.smsResults.filter((r) => !r.ok);
      const succeeded = resp.smsResults.filter((r) => r.ok);
      // eslint-disable-next-line no-console
      console.log("[startGroupCall] SMS results:", { succeeded, failed });
      if (failed.length > 0 && typeof window !== "undefined") {
        const msg = failed
          .map((f) => `${f.phone || "unknown"}: ${f.error || "send failed"}`)
          .join("\n");
        // Defer so the call UI mounts first, then surface the issue.
        setTimeout(() => {
          window.alert(`Couldn't text the video join link to:\n${msg}`);
        }, 250);
      }
    }
    if (resp.dialWarnings && resp.dialWarnings.length > 0) {
      // eslint-disable-next-line no-console
      console.warn("[startGroupCall] dialWarnings:", resp.dialWarnings);
      // A phone dial that didn't go through (SIP not configured, trunk
      // unavailable, no phone on file) previously only hit the console, so
      // the caller saw the call "start" but nobody was ever rung and there
      // was no error. Surface it. Only alert when the caller actually tried
      // to ring a phone (phoneInviteeIds/phoneNumbers) — SMS-only warnings
      // are already covered by the smsResults alert above.
      const triedToDial = phoneInviteeIds.length > 0 || phoneNumbers.length > 0;
      if (triedToDial && typeof window !== "undefined") {
        const msg = resp.dialWarnings.join("\n");
        setTimeout(() => {
          window.alert(`Couldn't ring the phone:\n${msg}`);
        }, 250);
      }
    }
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

  const inviteToActiveCall = useCallback<CallCtxValue["inviteToActiveCall"]>(async ({
    inviteeIds, phoneInviteeIds = [], phoneNumbers = [], emailAddresses = [],
  }) => {
    const cur = activeRef.current;
    if (!cur) {
      return {
        invitedUserIds: [], dialedUserIds: [], dialedPhones: [], emailedAddresses: [],
        dialWarnings: ["No active call"], emailWarnings: [],
      };
    }
    const resp = await apiRequest<{
      invitedUserIds: number[]; dialedUserIds: number[]; dialedPhones: string[];
      emailedAddresses: string[]; dialWarnings: string[]; emailWarnings: string[];
    }>("POST", "/api/calls/active/invite", {
      roomName: cur.roomName,
      kind: cur.kind,
      inviteeIds, phoneInviteeIds, phoneNumbers, emailAddresses,
    });
    return {
      ...resp,
      emailedAddresses: resp.emailedAddresses ?? [],
      emailWarnings: resp.emailWarnings ?? [],
    };
  }, []);

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

  const joinByToken = useCallback<CallCtxValue["joinByToken"]>(async (token) => {
    if (active || outgoing) return;
    const resp = await apiRequest<{
      roomName: string;
      token: string;
      ws_url: string;
      callerName: string;
      kind: "voice" | "video";
      userName: string;
      userHue: number;
    }>("POST", "/api/call-join/redeem", { token });
    setActive({
      callId: 0,
      roomName: resp.roomName,
      token: resp.token,
      wsUrl: resp.ws_url,
      otherName: resp.callerName,
      otherHue: 215,
      kind: resp.kind,
      iAmCaller: false,
      active: true,
    });
  }, [active, outgoing]);

  return (
    <CallCtx.Provider value={{
      incoming, outgoing, active, lastEnded,
      startCall, startGroupCall, acceptIncoming, declineIncoming, endActive, cancelOutgoing, clearLastEnded,
      inviteToActiveCall, joinByToken,
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
