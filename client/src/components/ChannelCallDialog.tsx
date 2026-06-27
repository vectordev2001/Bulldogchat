/**
 * ChannelCallDialog
 *
 * Opens when the user taps the Call or Video button in a text-channel
 * header. Lets them pick channel members to ring, then fires
 * `useCalls().startGroupCall(...)` which calls the server, creates a
 * shared LiveKit room, and drops the caller into the room while the
 * invitees see the standard incoming-call modal.
 *
 * UX:
 *   • Top toggle:   Voice  |  Video
 *   • Master row:   "Ring everyone in #channel" checkbox
 *   • Member list:  Each member with a checkbox + avatar; self is hidden
 *   • Footer:       Cancel + Start call button (disabled until ≥1 invitee)
 */

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Phone, Video, X, Loader2, Plus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useCalls } from "@/lib/CallContext";
import { apiRequest } from "@/lib/queryClient";
import type { ApiChannel, ApiUser } from "@/types/api";

interface Props {
  channel: ApiChannel;
  /** Effective channel members. Falls back to fetched list if absent. */
  fallbackMembers?: ApiUser[];
  /** Current user id — hidden from the picker (you can't ring yourself). */
  meId: number;
  open: boolean;
  /** Which mode the dialog was opened in. User can switch inside the dialog. */
  initialKind: "voice" | "video";
  onClose(): void;
}

export function ChannelCallDialog({ channel, fallbackMembers, meId, open, initialKind, onClose }: Props) {
  const { startGroupCall, active, outgoing } = useCalls();
  // Hash-router setter — wouter is mounted with useHashLocation in App.tsx.
  const [, navigate] = useLocation();
  const [kind, setKind] = useState<"voice" | "video">(initialKind);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Per-member call route: 'app' (in-app push + LiveKit join) or 'phone'
  // (server dials their saved cell via Twilio with 'Bulldog · #channel'
  // as caller-id). Map only holds entries for currently-selected members.
  // Defaults to 'app' when a row is first ticked.
  const [route, setRoute] = useState<Map<number, "app" | "phone">>(new Map());
  // Free-form phone numbers the caller wants to dial in alongside chat
  // members. Stored raw here; server normalizes to E.164 (US +1 default).
  // The recipient sees "Bulldog · #channel" as SIP From-display.
  const [phoneNumbers, setPhoneNumbers] = useState<string[]>([]);
  const [phoneInput, setPhoneInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to the requested kind every time the dialog reopens. Keeps the
  // button the user clicked in the channel header authoritative.
  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setError(null);
      setSubmitting(false);
      setPhoneNumbers([]);
      setPhoneInput("");
      setSelected(new Set());
      setRoute(new Map());
    }
  }, [open, initialKind]);

  function addPhone() {
    const raw = phoneInput.trim();
    if (!raw) return;
    const cleaned = raw.startsWith("+")
      ? "+" + raw.slice(1).replace(/\D/g, "")
      : "+1" + raw.replace(/\D/g, "");
    if (!/^\+\d{8,15}$/.test(cleaned)) {
      setError("Phone number must be at least 8 digits.");
      return;
    }
    if (phoneNumbers.includes(cleaned)) { setPhoneInput(""); return; }
    setPhoneNumbers((prev) => [...prev, cleaned]);
    setPhoneInput("");
    setError(null);
  }

  // Fetch effective channel members. The /channels/:id/members endpoint
  // returns the actual reachable list (handles global/entity/team/private
  // scope filtering server-side, so we don't have to replicate it here).
  const membersQ = useQuery<ApiUser[]>({
    queryKey: ["channel-members", channel.id],
    queryFn: () => apiRequest<ApiUser[]>("GET", `/api/channels/${channel.id}/members`),
    enabled: open,
    staleTime: 30_000,
  });

  // Prefer the live fetch; fall back to the caller-supplied org list so
  // we never render an empty picker if the request is in flight.
  const allMembers: ApiUser[] = useMemo(() => {
    const source = membersQ.data ?? fallbackMembers ?? [];
    return source.filter((m) => m.id !== meId && !m.deactivated);
  }, [membersQ.data, fallbackMembers, meId]);

  const allSelected = allMembers.length > 0 && selected.size === allMembers.length;
  const totalTargets = selected.size + phoneNumbers.length;

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
      setRoute(new Map());
    } else {
      const next = new Set(allMembers.map((m) => m.id));
      setSelected(next);
      // Default everyone added through Ring-everyone to 'app'.
      setRoute((prev) => {
        const merged = new Map(prev);
        for (const id of next) if (!merged.has(id)) merged.set(id, "app");
        return merged;
      });
    }
  }

  function toggleOne(id: number) {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
      setRoute((prev) => {
        if (!prev.has(id)) return prev;
        const m = new Map(prev);
        m.delete(id);
        return m;
      });
    } else {
      next.add(id);
      setRoute((prev) => {
        if (prev.has(id)) return prev;
        const m = new Map(prev);
        m.set(id, "app");
        return m;
      });
    }
    setSelected(next);
  }

  /** Switch a selected row between 'app' and 'phone'. */
  function setMemberRoute(id: number, r: "app" | "phone") {
    setRoute((prev) => {
      const m = new Map(prev);
      m.set(id, r);
      return m;
    });
  }

  // Phase 1.9.27: allow solo meeting start. Previously required at least one
  // target. Now an empty selection mints a solo room — the user can invite
  // people mid-call via the in-call "Add people" button.
  const canSubmit = !submitting && !active && !outgoing;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      // Split selected into app vs phone buckets. Default to 'app' if
      // somehow no route was recorded (defensive — toggleOne/toggleAll
      // both seed the map, but a future code path may not).
      const appIds: number[] = [];
      const phoneIds: number[] = [];
      for (const id of selected) {
        if ((route.get(id) ?? "app") === "phone") phoneIds.push(id);
        else appIds.push(id);
      }
      // skipAutoJoin: caller routes through /m/<code> (prejoin) instead of
      // dropping straight into the LiveKit room — so they can pick
      // mic/cam/output and review the device selector before joining.
      const { meetingCode } = await startGroupCall({
        channelId: channel.id,
        channelName: channel.name,
        inviteeIds: appIds,
        phoneInviteeIds: phoneIds,
        phoneNumbers,
        kind,
        skipAutoJoin: true,
      });
      onClose();
      if (meetingCode) {
        // wouter hash-router setter — see App.tsx useHashLocation. Using
        // window.location.href would skip the hash router and never
        // reach MeetingJoin.
        navigate(`/m/${meetingCode}`);
      }
    } catch (err: any) {
      // Most likely 503 (LiveKit not configured) or 400 (no reachable
      // invitees). Surface the server's `message` if present.
      const msg =
        (err && typeof err === "object" && "message" in err && String((err as any).message)) ||
        "Could not start the call. Try again.";
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-channel-call">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-display">
            <span className="text-vs-red">#{channel.name}</span>
            <span className="text-muted-foreground text-sm font-normal">— start a call</span>
          </DialogTitle>
        </DialogHeader>

        {/* Voice / Video toggle */}
        <div
          className="grid grid-cols-2 gap-2 p-1 bg-muted/30 rounded-md"
          data-testid="toggle-call-kind"
        >
          <button
            type="button"
            onClick={() => setKind("voice")}
            className={`flex items-center justify-center gap-2 py-2 rounded text-sm font-medium transition-colors ${
              kind === "voice" ? "bg-vs-red text-white" : "text-foreground/70 hover:text-foreground"
            }`}
            data-testid="button-kind-voice"
          >
            <Phone className="w-4 h-4" /> Voice
          </button>
          <button
            type="button"
            onClick={() => setKind("video")}
            className={`flex items-center justify-center gap-2 py-2 rounded text-sm font-medium transition-colors ${
              kind === "video" ? "bg-vs-red text-white" : "text-foreground/70 hover:text-foreground"
            }`}
            data-testid="button-kind-video"
          >
            <Video className="w-4 h-4" /> Video
          </button>
        </div>

        {/* Master "Ring everyone" row */}
        <label
          className="flex items-center gap-3 px-3 py-2 rounded-md border border-border bg-muted/20 hover:bg-muted/40 cursor-pointer"
          data-testid="row-ring-everyone"
        >
          <Checkbox
            checked={allSelected}
            onCheckedChange={toggleAll}
            data-testid="checkbox-ring-everyone"
          />
          <div className="flex-1">
            <div className="text-sm font-medium">
              Ring everyone in #{channel.name}
            </div>
            <div className="text-xs text-muted-foreground">
              {allMembers.length} {allMembers.length === 1 ? "person" : "people"}
            </div>
          </div>
        </label>

        {/* Member list */}
        <div className="max-h-64 overflow-y-auto rounded-md border border-border divide-y divide-border/60">
          {membersQ.isLoading && allMembers.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading members…
            </div>
          ) : allMembers.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No one else in this channel.
            </div>
          ) : (
            allMembers.map((m) => {
              const checked = selected.has(m.id);
              const memberRoute = route.get(m.id) ?? "app";
              const hasPhone = !!(m as { phone?: string | null }).phone;
              return (
                <div
                  key={m.id}
                  className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40"
                  data-testid={`row-invitee-${m.id}`}
                >
                  {/* Checkbox + identity click together to toggle selection. */}
                  <label className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleOne(m.id)}
                      data-testid={`checkbox-invitee-${m.id}`}
                    />
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold text-white shrink-0"
                      style={{ backgroundColor: `hsl(${m.hue} 70% 45%)` }}
                    >
                      {m.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "?"}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{m.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {hasPhone ? (m as { phone?: string | null }).phone : m.email}
                      </div>
                    </div>
                  </label>

                  {/* App / Phone segmented control — only shown when the
                      row is selected, so the picker doesn't get noisy. If
                      the member has no phone on file, the Phone option
                      is disabled (tooltip explains why). */}
                  {checked && (
                    <div className="flex items-center rounded-md border border-border overflow-hidden text-[11px] font-mono uppercase tracking-wider shrink-0">
                      <button
                        type="button"
                        onClick={() => setMemberRoute(m.id, "app")}
                        className={`px-2 py-1 flex items-center gap-1 transition-colors ${
                          memberRoute === "app"
                            ? "bg-vs-blue text-white"
                            : "bg-transparent text-muted-foreground hover:bg-muted/60"
                        }`}
                        title="Ring them in the Bulldog app"
                        data-testid={`button-route-app-${m.id}`}
                      >
                        <Video className="w-3 h-3" /> App
                      </button>
                      <button
                        type="button"
                        onClick={() => hasPhone && setMemberRoute(m.id, "phone")}
                        disabled={!hasPhone}
                        className={`px-2 py-1 flex items-center gap-1 transition-colors border-l border-border ${
                          memberRoute === "phone"
                            ? "bg-vs-red text-white"
                            : "bg-transparent text-muted-foreground hover:bg-muted/60"
                        } disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
                        title={hasPhone ? "Call their cell phone" : "No phone number on file"}
                        data-testid={`button-route-phone-${m.id}`}
                      >
                        <Phone className="w-3 h-3" /> Phone
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Free-form phone-number entry — lets the caller dial people who
            aren't (or shouldn't need to be) chat users. Server brands the
            outbound SIP call as "Bulldog · #channel" so the recipient
            knows it's coming from the app. They can answer on the phone
            or open the app to join. */}
        <div className="rounded-md border border-border bg-muted/20 px-3 py-2.5 space-y-2">
          <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Or dial a phone number
          </div>
          <div className="flex items-center gap-2">
            <input
              type="tel"
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPhone(); } }}
              placeholder="+1 555 123 4567"
              className="flex-1 h-9 px-3 rounded-md bg-background border border-border text-sm placeholder:text-muted-foreground focus:outline-none focus:border-vs-blue"
              data-testid="input-channel-call-phone"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addPhone}
              disabled={!phoneInput.trim()}
              data-testid="button-channel-call-phone-add"
            >
              <Plus className="w-3.5 h-3.5 mr-1" /> Add
            </Button>
          </div>
          {phoneNumbers.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {phoneNumbers.map((p) => (
                <span
                  key={p}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-vs-red/15 border border-vs-red/40 text-vs-red text-[11px] font-mono"
                  data-testid={`chip-channel-call-phone-${p}`}
                >
                  {p}
                  <button
                    type="button"
                    onClick={() => setPhoneNumbers((prev) => prev.filter((x) => x !== p))}
                    className="hover:opacity-80"
                    aria-label={`Remove ${p}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div
            className="text-xs text-vs-red bg-vs-red/10 border border-vs-red/40 rounded px-2 py-1.5"
            data-testid="text-call-error"
          >
            {error}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting} data-testid="button-cancel-call">
            <X className="w-4 h-4 mr-1" /> Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!canSubmit}
            className="bg-vs-red hover:bg-vs-red/90 text-white"
            data-testid="button-start-call"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin mr-1" />
            ) : kind === "video" ? (
              <Video className="w-4 h-4 mr-1" />
            ) : (
              <Phone className="w-4 h-4 mr-1" />
            )}
            {submitting
              ? "Starting…"
              : totalTargets === 0
                ? "Start solo — invite people later"
                : `Ring ${totalTargets} ${totalTargets === 1 ? "line" : "lines"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
