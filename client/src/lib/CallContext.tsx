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
import { loadMeetPrefs, MEET_PREFS_EVENT } from "@/lib/meet-prefs";

export interface IncomingCallData {
  callId: number;
  callerId: number;
  calleeId: number;
  callerName: string;
  callerHue: number;
  kind: "voice" | "video";
  roomName: string;
  /**
   * Channel context populated by the server SSE payload when the call
   * originated from a channel (group-call/start or add-to-active). null
   * for genuine 1:1 direct calls. Used by IncomingCallModal to show
   * "from #<channel>" and by acceptIncoming() below to seed the
   * ActiveCallSession so the MeetingClerk + in-call chat panel work
   * without regex-parsing the room name.
   */
  channelId?: number | null;
  channelName?: string | null;
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
  /** Channel this call is scoped to (enables chat panel + MeetingClerk). */
  channelId?: number | null;
  /** Human-readable channel name for the header / clerk banner. */
  channelName?: string | null;
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
    /**
     * When true, the server still creates the meeting + rings invitees,
     * but the caller is NOT dropped into the LiveKit room. The caller is
     * expected to navigate to /m/<code> (prejoin) so they can pick their
     * mic/camera/output before joining. Default false preserves the legacy
     * "drop straight in" huddle behavior for callers that opt in.
     */
    skipAutoJoin?: boolean;
  }): Promise<{ meetingCode: string | null; joinUrl: string | null }>;
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
  /**
   * Join an EXISTING channel group call by roomName. Used by the in-channel
   * "Join call" banner (surfaced after a push-notif deep link
   * /#/channels/<id>?call=<room> or when a channel call starts while this
   * user is already viewing the channel). Server mints a fresh LiveKit
   * token for the caller against the given room and returns the ws_url.
   * No-op if the user is already in a call.
   */
  joinChannelCall(opts: {
    channelId: number;
    channelName: string;
    roomName: string;
    kind?: "voice" | "video";
  }): Promise<void>;
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
  /** Shareable meeting code minted for this call (unified meetings model). */
  meetingCode?: string | null;
  /** Public guest-join URL for the meeting code. */
  joinUrl?: string | null;
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

  // Call sounds: synthesized via WebAudio so we don't ship an mp3 asset and
  // don't hit CDN/CORS concerns. Two distinct patterns — the caller hears a
  // US-style ringback (dual 440+480 Hz, 2s on / 4s off), the callee hears a
  // brief two-note chime every 3s. Both loops are gated on the
  // `callSoundsEnabled` preference (meet-prefs), which the user flips from
  // the profile dropdown when they need silence. Browsers require a prior
  // user gesture before AudioContext.resume() will succeed — fine here
  // because either the caller just clicked "call" or the callee has been
  // interacting with chat before the SSE arrived.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ringbackStopRef = useRef<(() => void) | null>(null);
  const chimeStopRef = useRef<(() => void) | null>(null);

  // Lazily create a single shared AudioContext. Reused across ringback +
  // chime + subsequent calls; we never close it (creating one per call
  // trips Chrome's per-page context limit after ~6 calls).
  const getAudioCtx = useCallback((): AudioContext | null => {
    if (typeof window === "undefined") return null;
    if (audioCtxRef.current) return audioCtxRef.current;
    try {
      const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
      if (!Ctor) return null;
      audioCtxRef.current = new Ctor();
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }, []);

  const stopRingback = useCallback(() => {
    if (ringbackStopRef.current) {
      ringbackStopRef.current();
      ringbackStopRef.current = null;
    }
  }, []);
  const stopChime = useCallback(() => {
    if (chimeStopRef.current) {
      chimeStopRef.current();
      chimeStopRef.current = null;
    }
  }, []);

  /**
   * Outgoing ringback for the CALLER. US-style precise-tone ring: two
   * simultaneous sines at 440 Hz + 480 Hz for 2s, then 4s silence, repeat.
   * Low gain (0.12) so it's audible but not startling on a good pair of
   * headphones. Reads the pref at call time so toggling mid-call takes
   * effect on the next 6-second cycle.
   */
  const playRingback = useCallback(() => {
    stopRingback();
    if (!loadMeetPrefs().callSoundsEnabled) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    // Some browsers start the context suspended until the first gesture;
    // resume() is a no-op if it's already running.
    ctx.resume().catch(() => { /* ignore */ });
    let cancelled = false;
    const scheduleBurst = () => {
      if (cancelled) return;
      if (!loadMeetPrefs().callSoundsEnabled) {
        // User toggled off mid-ring — self-cancel.
        stopRingback();
        return;
      }
      const t0 = ctx.currentTime;
      const burstLen = 2.0;
      const master = ctx.createGain();
      master.gain.value = 0.12;
      // Envelope: 30ms attack, 30ms release, sustained at 1.0 in between.
      master.gain.setValueAtTime(0, t0);
      master.gain.linearRampToValueAtTime(0.12, t0 + 0.03);
      master.gain.setValueAtTime(0.12, t0 + burstLen - 0.03);
      master.gain.linearRampToValueAtTime(0, t0 + burstLen);
      master.connect(ctx.destination);
      for (const freq of [440, 480]) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        osc.connect(master);
        osc.start(t0);
        osc.stop(t0 + burstLen);
      }
      // Next burst 6 seconds after this one started (2s on + 4s off).
      window.setTimeout(scheduleBurst, 6000);
    };
    scheduleBurst();
    ringbackStopRef.current = () => { cancelled = true; };
  }, [getAudioCtx, stopRingback]);

  /**
   * Incoming call chime for the CALLEE. Short two-note (E5 → G5) chime
   * every 3 seconds. Kept intentionally shorter/lighter than the ringback
   * so the user can hear it during another meeting without it drowning
   * conversation.
   */
  const playIncomingChime = useCallback(() => {
    stopChime();
    if (!loadMeetPrefs().callSoundsEnabled) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    ctx.resume().catch(() => { /* ignore */ });
    let cancelled = false;
    const scheduleChime = () => {
      if (cancelled) return;
      if (!loadMeetPrefs().callSoundsEnabled) {
        stopChime();
        return;
      }
      const t0 = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.value = 0.0;
      master.connect(ctx.destination);
      // Two notes: E5 (659.25) then G5 (783.99), each 180ms with a small overlap.
      const notes: Array<{ freq: number; start: number; len: number }> = [
        { freq: 659.25, start: 0.0, len: 0.22 },
        { freq: 783.99, start: 0.18, len: 0.28 },
      ];
      for (const n of notes) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = n.freq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t0 + n.start);
        g.gain.linearRampToValueAtTime(0.18, t0 + n.start + 0.02);
        g.gain.setValueAtTime(0.18, t0 + n.start + n.len - 0.04);
        g.gain.linearRampToValueAtTime(0, t0 + n.start + n.len);
        osc.connect(g);
        g.connect(master);
        osc.start(t0 + n.start);
        osc.stop(t0 + n.start + n.len + 0.02);
      }
      // Repeat every 3 seconds — well under the 30s ring timeout so users hear
      // it several times before missed.
      window.setTimeout(scheduleChime, 3000);
    };
    scheduleChime();
    chimeStopRef.current = () => { cancelled = true; };
  }, [getAudioCtx, stopChime]);

  // Legacy names preserved so downstream call sites don't churn. `playRing`
  // is used in the outgoing (caller) path; the incoming (callee) path now
  // uses `playIncomingChime` directly. `stopRing` stops BOTH so the callsite
  // doesn't need to know which one was playing.
  const playRing = playRingback;
  const stopRing = useCallback(() => {
    stopRingback();
    stopChime();
  }, [stopRingback, stopChime]);

  // Tear down the audio context on unmount (logout / page unload). Also
  // subscribe to the meet-prefs "changed" event so toggling Call sounds OFF
  // from the profile menu stops an in-flight ring immediately instead of
  // waiting for the next scheduled burst (up to 6s for ringback, 3s for chime).
  useEffect(() => {
    const onPrefsChanged = () => {
      if (!loadMeetPrefs().callSoundsEnabled) {
        stopRingback();
        stopChime();
      }
    };
    try { window.addEventListener(MEET_PREFS_EVENT, onPrefsChanged); } catch { /* ignore */ }
    return () => {
      try { window.removeEventListener(MEET_PREFS_EVENT, onPrefsChanged); } catch { /* ignore */ }
      stopRingback();
      stopChime();
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => { /* ignore */ });
        audioCtxRef.current = null;
      }
    };
  }, [stopRingback, stopChime]);

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
        // Callee-side: short two-note chime every 3s. Distinct from the
        // caller's ringback so the sound tells you which side you're on.
        playIncomingChime();
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
    smsInviteeIds = [], smsPhoneNumbers = [], kind = "voice", skipAutoJoin = false,
  }) => {
    if (outgoing || active) return { meetingCode: null, joinUrl: null };
    const resp = await apiRequest<StartGroupCallResponse>(
      "POST", `/api/channels/${channelId}/group-call/start`,
      { inviteeIds, phoneInviteeIds, phoneNumbers, smsInviteeIds, smsPhoneNumbers, kind },
    );
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
    }
    // skipAutoJoin: caller will route through /m/<code> (prejoin) so they
    // can pick mic/cam/output before joining. Do NOT setActive — that
    // would drop them straight into the LiveKit room and bypass prejoin.
    if (!skipAutoJoin) {
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
        channelId,
        channelName,
      });
    }
    return { meetingCode: resp.meetingCode ?? null, joinUrl: resp.joinUrl ?? null };
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
      // If this was a channel call, show "#channel" as the "other party"
      // banner label (matches the outbound group-call convention above).
      // Fall back to the caller's name for 1:1 calls.
      otherName: inc.channelName ? `#${inc.channelName}` : inc.callerName,
      otherHue: inc.channelName ? 215 : inc.callerHue,
      kind: inc.kind,
      iAmCaller: false,
      active: true,
      // Seed channel context from the SSE payload so the MeetingClerk
      // auto-consent banner and in-call chat panel key off the same id
      // the server already resolved. Fallbacks to null for 1:1 calls.
      channelId: inc.channelId ?? null,
      channelName: inc.channelName ?? null,
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

  // Join an existing channel call by roomName. The Join-call banner in
  // TextChannelView calls this after a deep link surfaces a pending call.
  // Server-side we hit the dedicated /api/channels/:id/group-call/join
  // endpoint (as opposed to /group-call/start which would mint a new room).
  const joinChannelCall = useCallback<CallCtxValue["joinChannelCall"]>(async ({
    channelId, channelName, roomName, kind = "voice",
  }) => {
    if (active || outgoing) return;
    const resp = await apiRequest<{
      roomName: string;
      token: string;
      ws_url: string;
      kind: "voice" | "video";
      channelId: number;
      channelName: string | null;
    }>("POST", `/api/channels/${channelId}/group-call/join`, { roomName, kind });
    setActive({
      callId: 0,
      roomName: resp.roomName,
      token: resp.token,
      wsUrl: resp.ws_url,
      otherName: `#${resp.channelName ?? channelName}`,
      otherHue: 215,
      kind: resp.kind,
      iAmCaller: false,
      active: true,
      channelId: resp.channelId,
      channelName: resp.channelName ?? channelName,
    });
  }, [active, outgoing]);

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
      channelId?: number | null;
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
      channelId: resp.channelId ?? null,
    });
  }, [active, outgoing]);

  return (
    <CallCtx.Provider value={{
      incoming, outgoing, active, lastEnded,
      startCall, startGroupCall, acceptIncoming, declineIncoming, endActive, cancelOutgoing, clearLastEnded,
      inviteToActiveCall, joinByToken, joinChannelCall,
    }}>
      {children}
    </CallCtx.Provider>
  );
}

/**
 * @deprecated Retained only for reference — the previous silent-data-URI
 * ringtone. Replaced by the WebAudio synthesis inside CallContextProvider
 * (playRingback + playIncomingChime). Safe to delete once no external
 * consumers reference it.
 *
 * A short data-URI ringtone (about half a second of 880Hz on/off bursts).
 * Generated offline so we don't ship a real mp3. The browser loops it.
 * If decoding fails (very old browser), playRing() silently no-ops \u2014
 * the visual modal still appears.
 */
// 100ms 880Hz square wave repeated; small wav header in base64.
// Kept as a string constant to avoid an extra fetch.
const RING_TONE_DATA_URI = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";
