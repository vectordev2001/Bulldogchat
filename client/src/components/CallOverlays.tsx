/**
 * CallOverlays — full-screen UI for incoming, outgoing, and active 1:1
 * calls. Mounts once at the app root so the modal appears no matter
 * which page the user is on when the phone rings.
 */
import { useEffect, useMemo, useRef } from "react";
import { Phone, PhoneOff, Mic, MicOff, Video, VideoOff, MonitorUp, Loader2, Volume2, UserPlus, X, Check, Search, PhoneCall } from "lucide-react";
import { useCalls } from "@/lib/CallContext";
import { useLiveKitRoom, attachTrack } from "@/lib/useLiveKitRoom";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Avatar } from "./Avatar";
import type { Track } from "livekit-client";
import type { RoomParticipantState } from "@/lib/useLiveKitRoom";
import type { ApiUser } from "@/types/api";
import { useAuth } from "@/lib/auth";

export function CallOverlays() {
  const calls = useCalls();
  return (
    <>
      {calls.incoming && <IncomingCallModal />}
      {calls.outgoing && <OutgoingCallModal />}
      {calls.active && <ActiveCallOverlay />}
      {calls.lastEnded && <EndedToast />}
    </>
  );
}

/* ────────────────── Incoming (ringing) modal ────────────────── */

function IncomingCallModal() {
  const { incoming, acceptIncoming, declineIncoming } = useCalls();
  if (!incoming) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm" data-testid="modal-incoming-call">
      <div className="w-full max-w-sm rounded-2xl bg-[hsl(232_60%_12%)] border border-[hsl(232_40%_22%)] p-6 shadow-2xl text-center">
        <div className="text-xs font-mono uppercase tracking-[0.18em] text-vs-blue-light mb-4 animate-pulse">
          Incoming {incoming.kind === "video" ? "video" : "voice"} call
        </div>
        <div className="flex justify-center mb-4">
          <div className="speaking-ring rounded-full">
            <Avatar member={{ name: incoming.callerName, hue: incoming.callerHue }} size={96} ring="blue" />
          </div>
        </div>
        <div className="text-xl font-display text-white mb-1">{incoming.callerName}</div>
        <div className="text-xs text-[hsl(0_0%_60%)] font-mono mb-6">is calling you</div>
        <div className="flex gap-3 justify-center">
          <button
            type="button"
            onClick={() => { void declineIncoming(); }}
            className="h-14 w-14 rounded-full bg-vs-red hover:bg-[hsl(2_75%_60%)] text-white flex items-center justify-center shadow-lg transition-colors"
            title="Decline"
            data-testid="button-decline-call"
          >
            <PhoneOff className="w-6 h-6" />
          </button>
          <button
            type="button"
            onClick={() => { void acceptIncoming(); }}
            className="h-14 w-14 rounded-full bg-vs-green hover:bg-[hsl(145_60%_55%)] text-[hsl(232_60%_9%)] flex items-center justify-center shadow-lg transition-colors"
            title="Accept"
            data-testid="button-accept-call"
          >
            <Phone className="w-6 h-6" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ────────────────── Outgoing (calling…) modal ────────────────── */

function OutgoingCallModal() {
  const { outgoing, cancelOutgoing } = useCalls();
  if (!outgoing) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm" data-testid="modal-outgoing-call">
      <div className="w-full max-w-sm rounded-2xl bg-[hsl(232_60%_12%)] border border-[hsl(232_40%_22%)] p-6 shadow-2xl text-center">
        <div className="text-xs font-mono uppercase tracking-[0.18em] text-vs-amber mb-4 flex items-center justify-center gap-2">
          <Loader2 className="w-3 h-3 animate-spin" />
          Calling…
        </div>
        <div className="flex justify-center mb-4">
          <Avatar member={{ name: outgoing.calleeName, hue: outgoing.calleeHue }} size={96} />
        </div>
        <div className="text-xl font-display text-white mb-1">{outgoing.calleeName}</div>
        <div className="text-xs text-[hsl(0_0%_60%)] font-mono mb-6">
          {outgoing.kind === "video" ? "Video call" : "Voice call"} · waiting for them to pick up
        </div>
        <button
          type="button"
          onClick={() => { void cancelOutgoing(); }}
          className="h-12 px-6 rounded-full bg-vs-red hover:bg-[hsl(2_75%_60%)] text-white flex items-center gap-2 mx-auto shadow-lg transition-colors"
          data-testid="button-cancel-call"
        >
          <PhoneOff className="w-4 h-4" />
          <span className="text-sm font-semibold">Cancel</span>
        </button>
      </div>
    </div>
  );
}

/* ────────────────── Active call overlay ────────────────── */

function ActiveCallOverlay() {
  const { active, endActive } = useCalls();
  const [micMuted, setMicMuted] = useState(false);
  const [videoOn, setVideoOn] = useState(active?.kind === "video");
  const [screenSharing, setScreenSharing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  // Reset toggles when the call changes.
  useEffect(() => {
    setMicMuted(false);
    setVideoOn(active?.kind === "video");
    setScreenSharing(false);
  }, [active?.callId, active?.kind]);

  const lk = useLiveKitRoom({
    token: active?.token ?? null,
    wsUrl: active?.wsUrl ?? null,
    roomKey: active ? `direct-${active.callId}` : null,
    micMuted,
    videoOn,
    screenSharing,
    onTrackError: (kind, err) => {
      console.warn(`[call] ${kind} error`, err);
      if (kind === "camera") setVideoOn(false);
      if (kind === "screen") setScreenSharing(false);
    },
  });

  if (!active) return null;

  const other = lk.participants.find(p => !p.isLocal) ?? null;
  const me = lk.participants.find(p => p.isLocal) ?? null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-[hsl(232_65%_8%)] text-white" data-testid="overlay-active-call">
      {/* Header */}
      <header className="h-14 px-4 flex items-center gap-3 border-b border-[hsl(232_40%_22%)] shrink-0 bg-[hsl(232_60%_12%)]/60 backdrop-blur-sm">
        <Volume2 className="w-5 h-5 text-vs-blue shrink-0" />
        <div className="font-display text-white text-base truncate">{active.otherName}</div>
        <span className="text-xs text-[hsl(0_0%_65%)] font-mono whitespace-nowrap hidden sm:inline">
          · {active.kind === "video" ? "Video" : "Voice"} call
        </span>
        <div className="ml-auto text-xs font-mono text-[hsl(0_0%_65%)] whitespace-nowrap">
          {lk.status === "connecting" || lk.status === "reconnecting" ? "Connecting…"
            : lk.status === "failed" ? <span className="text-vs-red">Connection failed</span>
            : <span className="text-vs-green">Connected</span>}
        </div>
      </header>

      {/* Body: two tiles (you + them). Larger remote tile if video. */}
      <div className="flex-1 min-h-0 p-6 flex items-center justify-center">
        <div className="w-full max-w-4xl grid gap-4 grid-cols-1 sm:grid-cols-2">
          <CallTile name={active.otherName} hue={active.otherHue} participant={other} isMe={false} kind={active.kind} />
          <CallTile name="You" hue={210} participant={me} isMe={true} kind={active.kind} muted={micMuted} videoOff={!videoOn} />
        </div>
      </div>

      {/* Hidden audio sink so the remote can be heard. */}
      <RemoteAudio participant={other} />

      {/* Error banner */}
      {lk.error && (
        <div className="px-4 py-2 bg-[hsl(2_70%_55%/0.15)] border-y border-[hsl(2_70%_55%/0.4)] text-xs text-[hsl(2_85%_75%)] text-center">
          {lk.error}
        </div>
      )}

      {/* Controls */}
      <div className="shrink-0 px-6 py-4 border-t border-[hsl(232_40%_22%)] bg-[hsl(232_55%_11%)] flex flex-col items-center gap-2">
        {/* When LiveKit isn't connected yet the toggles below are no-ops.
            Make that loud and visible so users don't think the buttons are
            broken — the underlying reconcile effects only fire once we
            reach "connected". */}
        {lk.status !== "connected" && (
          <div className="text-[11px] uppercase tracking-wider font-mono text-[hsl(40_80%_60%)]">
            {lk.status === "connecting" || lk.status === "reconnecting"
              ? "Connecting… controls active once connected"
              : lk.status === "failed"
              ? "Call failed to connect. End and try again."
              : "Waiting for media…"}
          </div>
        )}
        <div className="flex items-center justify-center gap-3">
        <CtrlBtn on={!micMuted} onClick={() => setMicMuted(m => !m)} disabled={lk.status !== "connected"} onIcon={<Mic className="w-5 h-5" />} offIcon={<MicOff className="w-5 h-5" />} title={micMuted ? "Unmute" : "Mute"} testid="call-mic" />
        <CtrlBtn on={videoOn} onClick={() => setVideoOn(v => !v)} disabled={lk.status !== "connected"} onIcon={<Video className="w-5 h-5" />} offIcon={<VideoOff className="w-5 h-5" />} title={videoOn ? "Stop video" : "Start video"} testid="call-video" />
        <CtrlBtn on={screenSharing} onClick={() => setScreenSharing(s => !s)} disabled={lk.status !== "connected"} onIcon={<MonitorUp className="w-5 h-5" />} offIcon={<MonitorUp className="w-5 h-5" />} title={screenSharing ? "Stop sharing" : "Share screen"} testid="call-screen" />
        {/* Add people to this call. Opens a picker; selected users get
            rung into the same LiveKit room, phone-route users get dialed
            via Twilio with caller-id 'Bulldog · <channel-or-name>'. */}
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="w-12 h-12 rounded-full flex items-center justify-center bg-[hsl(232_45%_27%)] hover:bg-[hsl(232_45%_32%)] text-white transition-colors"
          title="Add people to this call"
          aria-label="Add people to this call"
          data-testid="button-call-add"
        >
          <UserPlus className="w-5 h-5" />
        </button>
        <div className="w-3" />
        <button
          type="button"
          onClick={() => { void endActive(); }}
          className="h-12 px-6 rounded-full bg-vs-red hover:bg-[hsl(2_75%_60%)] text-white flex items-center gap-2 shadow-lg transition-colors"
          data-testid="button-end-call"
        >
          <PhoneOff className="w-4 h-4" />
          <span className="text-sm font-semibold">End</span>
        </button>
        </div>
      </div>

      {addOpen && <InCallAddDialog onClose={() => setAddOpen(false)} />}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * InCallAddDialog — picker shown when the caller taps the UserPlus
 * button on the active-call overlay. Lists org members (minus self and
 * deactivated), search bar, per-row App|Phone segmented control, and a
 * free-form phone number field. Submits to inviteToActiveCall() which
 * hits /api/calls/active/invite — server rings them into the live room.
 * ────────────────────────────────────────────────────────────────────────── */

function InCallAddDialog({ onClose }: { onClose: () => void }) {
  const { inviteToActiveCall } = useCalls();
  const { user } = useAuth();
  const meId = (user as ApiUser | null)?.id;

  const membersQ = useQuery<ApiUser[]>({ queryKey: ["/api/org/members"] });
  const allMembers = useMemo(
    () => (membersQ.data ?? []).filter((m) => m.id !== meId && !(m as { deactivated?: boolean }).deactivated),
    [membersQ.data, meId],
  );

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [route, setRoute] = useState<Map<number, "app" | "phone">>(new Map());
  const [phoneInput, setPhoneInput] = useState("");
  const [phoneNumbers, setPhoneNumbers] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allMembers;
    return allMembers.filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
  }, [allMembers, query]);

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
    setRoute((prev) => {
      const next = new Map(prev);
      if (!next.has(id)) next.set(id, "app");
      return next;
    });
  };

  const setRouteFor = (id: number, r: "app" | "phone") => {
    setRoute((prev) => { const next = new Map(prev); next.set(id, r); return next; });
  };

  const addPhone = () => {
    const raw = phoneInput.trim();
    if (!raw) return;
    const normalized = raw.startsWith("+")
      ? "+" + raw.slice(1).replace(/\D/g, "")
      : "+1" + raw.replace(/\D/g, "");
    if (!/^\+\d{8,15}$/.test(normalized)) { setError("Enter a valid phone number"); return; }
    if (phoneNumbers.includes(normalized)) { setPhoneInput(""); return; }
    setPhoneNumbers((p) => [...p, normalized]);
    setPhoneInput("");
    setError(null);
  };

  const totalTargets = selected.size + phoneNumbers.length;

  const submit = async () => {
    if (totalTargets === 0) { setError("Pick at least one person or phone number"); return; }
    const appIds: number[] = [];
    const phoneIds: number[] = [];
    for (const id of Array.from(selected)) {
      if (route.get(id) === "phone") phoneIds.push(id); else appIds.push(id);
    }
    setSubmitting(true);
    setError(null);
    setWarnings([]);
    try {
      const resp = await inviteToActiveCall({
        inviteeIds: appIds, phoneInviteeIds: phoneIds, phoneNumbers,
      });
      if (resp.dialWarnings.length > 0) {
        setWarnings(resp.dialWarnings);
        // Keep the dialog open so the user can see the warnings;
        // they can close manually.
      } else {
        onClose();
      }
    } catch (err) {
      setError((err as { message?: string })?.message ?? "Failed to add people");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-end md:items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      data-testid="dialog-in-call-add"
    >
      <div
        className="w-full md:w-[520px] md:max-w-[92vw] max-h-[92vh] flex flex-col bg-[hsl(232_55%_13%)] border border-[hsl(232_40%_25%)] md:rounded-2xl rounded-t-2xl shadow-2xl overflow-hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[hsl(232_40%_22%)] flex items-center justify-between shrink-0">
          <div className="min-w-0">
            <div className="text-sm font-display text-white">Add to this call</div>
            <div className="text-[10px] text-[hsl(0_0%_60%)] font-mono uppercase tracking-wider">
              Ring more people into the live room
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-[hsl(0_0%_70%)] hover:text-white hover:bg-black/30"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-3 py-2 border-b border-[hsl(232_40%_22%)] shrink-0">
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-[hsl(232_50%_18%)] border border-[hsl(232_40%_25%)]">
            <Search className="w-4 h-4 text-[hsl(0_0%_55%)] shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search members…"
              className="flex-1 bg-transparent text-sm text-white placeholder:text-[hsl(0_0%_50%)] outline-none"
              data-testid="input-in-call-add-search"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {membersQ.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-vs-blue" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center text-xs text-[hsl(0_0%_60%)] py-6">No members match “{query}”</div>
          ) : (
            <ul className="px-2 py-2 flex flex-col gap-1">
              {filtered.map((m) => {
                const isSel = selected.has(m.id);
                const r = route.get(m.id) ?? "app";
                const hasPhone = !!(m.phone && m.phone.trim());
                return (
                  <li key={m.id}>
                    <div
                      className={[
                        "flex items-center gap-2 px-2 py-1.5 rounded-md",
                        isSel ? "bg-[hsl(232_50%_22%)] ring-1 ring-vs-blue/40" : "hover:bg-[hsl(232_45%_22%)]",
                      ].join(" ")}
                    >
                      <button
                        type="button"
                        onClick={() => toggleOne(m.id)}
                        className="flex-1 min-w-0 flex items-center gap-2 text-left"
                        data-testid={`in-call-add-row-${m.id}`}
                      >
                        <div className={[
                          "w-5 h-5 rounded-md border flex items-center justify-center shrink-0",
                          isSel ? "bg-vs-blue border-vs-blue text-[hsl(232_60%_9%)]" : "border-[hsl(0_0%_45%)]",
                        ].join(" ")}>
                          {isSel && <Check className="w-3 h-3" strokeWidth={3} />}
                        </div>
                        <Avatar member={{ name: m.name, hue: m.hue }} size={28} />
                        <div className="min-w-0">
                          <div className="text-sm text-white truncate">{m.name}</div>
                          <div className="text-[10px] text-[hsl(0_0%_60%)] truncate">{m.email}</div>
                        </div>
                      </button>
                      {isSel && (
                        <div className="flex items-center gap-0.5 shrink-0 bg-[hsl(232_60%_11%)] rounded-md p-0.5 border border-[hsl(232_40%_25%)]">
                          <button
                            type="button"
                            onClick={() => setRouteFor(m.id, "app")}
                            className={[
                              "px-2 py-1 rounded text-[11px] font-mono uppercase tracking-wider flex items-center gap-1",
                              r === "app" ? "bg-vs-blue text-[hsl(232_60%_9%)]" : "text-[hsl(0_0%_65%)] hover:text-white",
                            ].join(" ")}
                            title="Ring in the app"
                          >
                            <Video className="w-3 h-3" /> App
                          </button>
                          <button
                            type="button"
                            onClick={() => hasPhone && setRouteFor(m.id, "phone")}
                            disabled={!hasPhone}
                            className={[
                              "px-2 py-1 rounded text-[11px] font-mono uppercase tracking-wider flex items-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed",
                              r === "phone" ? "bg-vs-red text-white" : "text-[hsl(0_0%_65%)] hover:text-white",
                            ].join(" ")}
                            title={hasPhone ? "Dial their cell" : "No phone on file"}
                          >
                            <PhoneCall className="w-3 h-3" /> Phone
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="shrink-0 px-3 py-2 border-t border-[hsl(232_40%_22%)] bg-[hsl(232_55%_11%)] flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-wider font-mono text-[hsl(0_0%_55%)]">Or dial a phone number</div>
          <div className="flex items-center gap-2">
            <input
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPhone(); } }}
              placeholder="+1 555 123 4567"
              inputMode="tel"
              className="flex-1 bg-[hsl(232_50%_18%)] border border-[hsl(232_40%_25%)] rounded-md px-2 py-1.5 text-sm text-white placeholder:text-[hsl(0_0%_45%)] outline-none focus:border-vs-blue"
              data-testid="input-in-call-add-phone"
            />
            <button
              type="button"
              onClick={addPhone}
              className="px-3 py-1.5 rounded-md bg-[hsl(232_45%_27%)] hover:bg-[hsl(232_45%_32%)] text-white text-sm"
            >
              Add
            </button>
          </div>
          {phoneNumbers.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {phoneNumbers.map((p) => (
                <span key={p} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-vs-red/15 border border-vs-red/40 text-[hsl(2_85%_75%)]">
                  {p}
                  <button type="button" onClick={() => setPhoneNumbers((arr) => arr.filter((x) => x !== p))} className="hover:text-white" aria-label={`Remove ${p}`}>
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {warnings.length > 0 && (
          <div className="shrink-0 px-3 py-2 bg-[hsl(40_80%_45%/0.12)] border-t border-[hsl(40_80%_45%/0.4)] text-xs text-[hsl(40_80%_75%)]">
            {warnings.map((w, i) => <div key={i}>• {w}</div>)}
          </div>
        )}
        {error && (
          <div className="shrink-0 px-3 py-2 bg-[hsl(2_70%_55%/0.15)] border-t border-[hsl(2_70%_55%/0.4)] text-xs text-[hsl(2_85%_75%)]">{error}</div>
        )}

        <div className="shrink-0 px-3 py-3 border-t border-[hsl(232_40%_22%)] bg-[hsl(232_55%_13%)] flex items-center justify-between gap-2">
          <span className="text-[11px] text-[hsl(0_0%_60%)] font-mono">
            {totalTargets > 0 ? `${totalTargets} to add` : "Pick people or phone numbers"}
          </span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-sm text-[hsl(0_0%_75%)] hover:text-white">
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={submitting || totalTargets === 0}
              className="px-4 py-1.5 rounded-md bg-vs-red hover:bg-[hsl(2_75%_60%)] text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              data-testid="button-in-call-add-submit"
            >
              {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Ring them
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CallTile({
  name, hue, participant, isMe, kind, muted, videoOff,
}: {
  name: string; hue: number;
  participant: RoomParticipantState | null;
  isMe: boolean;
  kind: "voice" | "video";
  muted?: boolean;
  videoOff?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const track = participant?.videoTrack ?? null;
  useEffect(() => {
    if (!videoRef.current) return;
    return attachTrack(track, videoRef.current);
  }, [track]);

  const speaking = participant?.isSpeaking && !participant?.micMuted;
  const isMuted = participant?.micMuted ?? (isMe ? !!muted : false);
  const hasVideo = !!track && !videoOff;

  return (
    <div
      className={[
        "relative aspect-video rounded-2xl overflow-hidden border-2 transition-colors bg-[hsl(232_55%_11%)]",
        speaking ? "border-vs-blue shadow-xl" : "border-[hsl(232_40%_25%)]",
      ].join(" ")}
      data-testid={`call-tile-${isMe ? "me" : "them"}`}
    >
      {track && !videoOff && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted // remote audio handled separately
          className="absolute inset-0 w-full h-full object-cover"
          style={{ transform: isMe ? "scaleX(-1)" : undefined }}
        />
      )}
      {!hasVideo && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className={speaking ? "speaking-ring rounded-full" : ""}>
            <Avatar member={{ name, hue }} size={128} ring={speaking ? "blue" : "none"} />
          </div>
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 px-4 py-3 bg-gradient-to-t from-black/80 to-transparent flex items-center justify-between">
        <span className="text-sm font-semibold text-white">{name}{isMe && " (you)"}</span>
        <span
          className={[
            "w-7 h-7 rounded-full flex items-center justify-center",
            isMuted ? "bg-vs-red text-white" : speaking ? "bg-vs-blue text-[hsl(232_60%_9%)]" : "bg-[hsl(232_45%_27%)] text-[hsl(0_0%_85%)]",
          ].join(" ")}
        >
          {isMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
        </span>
      </div>
    </div>
  );
}

function RemoteAudio({ participant }: { participant: RoomParticipantState | null }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    return attachTrack(participant?.audioTrack ?? null, ref.current);
  }, [participant?.audioTrack]);
  return <audio ref={ref} autoPlay className="sr-only" />;
}

function CtrlBtn({
  on, onClick, onIcon, offIcon, title, testid, disabled,
}: {
  on: boolean;
  onClick(): void;
  onIcon: React.ReactNode;
  offIcon: React.ReactNode;
  title: string;
  testid?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? `${title} (not connected yet)` : title}
      data-testid={testid}
      className={[
        "w-12 h-12 rounded-full flex items-center justify-center transition-all",
        disabled ? "opacity-40 cursor-not-allowed" : "",
        on
          ? "bg-[hsl(232_45%_27%)] hover:bg-[hsl(232_45%_32%)] text-white"
          : "bg-[hsl(2_70%_55%/0.25)] hover:bg-[hsl(2_70%_55%/0.35)] text-[hsl(2_85%_72%)] ring-1 ring-[hsl(2_70%_55%/0.4)]",
      ].join(" ")}
    >
      {on ? onIcon : offIcon}
    </button>
  );
}

/* ────────────────── Brief "missed/declined" toast ────────────────── */

function EndedToast() {
  const { lastEnded, clearLastEnded } = useCalls();
  useEffect(() => {
    if (!lastEnded) return;
    const id = setTimeout(() => clearLastEnded(), 4000);
    return () => clearTimeout(id);
  }, [lastEnded, clearLastEnded]);

  if (!lastEnded) return null;

  const label = lastEnded.reason === "missed" ? "Missed call"
    : lastEnded.reason === "declined" ? "Call declined"
    : "Call ended";

  return (
    <div className="fixed bottom-6 right-6 z-[110] max-w-xs px-4 py-3 rounded-lg bg-[hsl(232_60%_14%)] border border-[hsl(232_40%_25%)] shadow-2xl text-white flex items-center gap-3" data-testid="toast-call-ended">
      <PhoneOff className="w-4 h-4 text-vs-red shrink-0" />
      <div className="min-w-0">
        <div className="text-xs font-mono uppercase tracking-wider text-[hsl(0_0%_65%)]">{label}</div>
        <div className="text-sm font-semibold truncate">{lastEnded.otherName}</div>
      </div>
    </div>
  );
}
