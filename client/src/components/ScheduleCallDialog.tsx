import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import type { ApiUser, ApiChannel } from "@/types/api";
import { Loader2, Video, Mic, Calendar as CalIcon, X, Plus, Search, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

/**
 * ScheduleCallDialog — modal for creating a scheduled call.
 *
 * Fields: title, optional notes, start datetime (local), duration (min),
 * voice/video, attendees (chat users + raw phones + raw emails),
 * optional channel (where the in-channel RSVP card gets posted).
 *
 * On submit, POSTs to /api/scheduled-calls. Server dispatches SMS/email
 * invites and posts an in-channel RSVP card asynchronously.
 *
 * Also reachable via the /schedule slash command (which prefills title +
 * channelId). See useScheduleSlashCommand below.
 */
export function ScheduleCallDialog({
  open,
  onClose,
  orgMembers,
  channels,
  me,
  defaultChannelId,
  defaultTitle,
  defaultStartAt,
  defaultDurationMin,
}: {
  open: boolean;
  onClose: () => void;
  orgMembers: ApiUser[];
  channels: ApiChannel[];
  me: ApiUser;
  defaultChannelId?: number | null;
  defaultTitle?: string;
  defaultStartAt?: Date;
  defaultDurationMin?: number;
}) {
  const qc = useQueryClient();

  // Form state. Re-init when the dialog opens so re-uses don't leak.
  const [title, setTitle] = useState(defaultTitle ?? "");
  const [notes, setNotes] = useState("");
  const [kind, setKind] = useState<"voice" | "video">("video");
  const [provider, setProvider] = useState<"bulldog" | "both" | "teams">("both");
  const [startLocal, setStartLocal] = useState<string>("");
  const [durationMin, setDurationMin] = useState<number>(defaultDurationMin ?? 30);
  const [channelId, setChannelId] = useState<number | null>(defaultChannelId ?? null);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<number>>(new Set());
  const [extraPhones, setExtraPhones] = useState<string[]>([]);
  const [extraEmails, setExtraEmails] = useState<string[]>([]);
  const [phoneDraft, setPhoneDraft] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(defaultTitle ?? "");
    setNotes("");
    setKind("video");
    setProvider("both");
    // Default to "in 30 minutes" rounded to next 5min, in user's local TZ.
    const d = defaultStartAt ?? new Date(Date.now() + 30 * 60_000);
    const ms = 5 * 60_000;
    const rounded = new Date(Math.ceil(d.getTime() / ms) * ms);
    setStartLocal(toLocalInputValue(rounded));
    setDurationMin(defaultDurationMin ?? 30);
    setChannelId(defaultChannelId ?? null);
    setSelectedUserIds(new Set());
    setExtraPhones([]);
    setExtraEmails([]);
    setPhoneDraft("");
    setEmailDraft("");
    setQ("");
    setErr(null);
  }, [open, defaultTitle, defaultChannelId, defaultStartAt, defaultDurationMin]);

  const candidates = useMemo(() => {
    const term = q.trim().toLowerCase();
    return orgMembers
      .filter((m) => !m.deactivated && m.id !== me.id)
      .filter((m) => !term || m.name.toLowerCase().includes(term))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [orgMembers, q, me.id]);

  const toggleUser = (id: number) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addPhone = () => {
    const p = phoneDraft.trim();
    if (!p) return;
    setExtraPhones((prev) => Array.from(new Set([...prev, p])));
    setPhoneDraft("");
  };

  const addEmail = () => {
    const e = emailDraft.trim();
    if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return;
    setExtraEmails((prev) => Array.from(new Set([...prev, e])));
    setEmailDraft("");
  };

  const createMut = useMutation({
    mutationFn: async () => {
      const startMs = parseLocalInputValue(startLocal);
      if (!startMs) throw new Error("Invalid start time");
      const start = new Date(startMs);
      const end = new Date(startMs + durationMin * 60_000);
      const body = {
        title: title.trim(),
        notes: notes.trim() || undefined,
        kind,
        provider,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        channelId: typeof channelId === "number" && channelId > 0 ? channelId : undefined,
        userIds: Array.from(selectedUserIds),
        phones: extraPhones,
        emails: extraEmails,
      };
      return apiRequest("POST", "/api/scheduled-calls", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/scheduled-calls"] });
      onClose();
    },
    onError: (e: any) => {
      setErr(e?.message ?? "Failed to schedule call");
    },
  });

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto bg-[hsl(220_55%_13%)] border-[hsl(220_40%_25%)] text-white">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display tracking-wide">
            <CalIcon className="w-4 h-4 text-vs-blue-light" />
            Schedule a call
          </DialogTitle>
          <DialogDescription className="text-[11px] text-[hsl(0_0%_65%)] font-mono uppercase tracking-wider">
            Invitees receive an SMS + calendar (.ics) file
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 mt-2">
          {/* Title */}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[hsl(0_0%_65%)] font-mono">Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Weekly safety check-in"
              className="bg-[hsl(220_50%_18%)] border border-[hsl(220_40%_25%)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-vs-blue-light"
              data-testid="input-schedule-title"
            />
          </label>

          {/* Type + duration */}
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-[hsl(0_0%_65%)] font-mono">Type</span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setKind("video")}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm border ${
                    kind === "video"
                      ? "bg-vs-blue-light/15 border-vs-blue-light text-white"
                      : "bg-[hsl(220_50%_18%)] border-[hsl(220_40%_25%)] text-[hsl(0_0%_70%)]"
                  }`}
                  data-testid="button-schedule-kind-video"
                >
                  <Video className="w-3.5 h-3.5" /> Video
                </button>
                <button
                  type="button"
                  onClick={() => setKind("voice")}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm border ${
                    kind === "voice"
                      ? "bg-vs-green/15 border-vs-green text-white"
                      : "bg-[hsl(220_50%_18%)] border-[hsl(220_40%_25%)] text-[hsl(0_0%_70%)]"
                  }`}
                  data-testid="button-schedule-kind-voice"
                >
                  <Mic className="w-3.5 h-3.5" /> Voice
                </button>
              </div>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-[hsl(0_0%_65%)] font-mono">Duration (min)</span>
              <input
                type="number"
                min={5}
                max={480}
                step={5}
                value={durationMin}
                onChange={(e) => setDurationMin(Math.max(5, Number(e.target.value) || 30))}
                className="bg-[hsl(220_50%_18%)] border border-[hsl(220_40%_25%)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-vs-blue-light"
                data-testid="input-schedule-duration"
              />
            </label>
          </div>

          {kind === "video" && (
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wider text-white/50 mb-1.5 font-semibold">
                Video provider
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setProvider("bulldog")}
                  className={`flex-1 px-3 py-2 rounded-md border text-[12px] font-semibold transition-colors ${
                    provider === "bulldog"
                      ? "bg-vs-blue/30 border-vs-blue text-white"
                      : "bg-white/5 border-white/15 text-white/70 hover:bg-white/10"
                  }`}
                  data-testid="button-provider-bulldog"
                >
                  Bulldog only
                </button>
                <button
                  type="button"
                  onClick={() => setProvider("both")}
                  className={`flex-1 px-3 py-2 rounded-md border text-[12px] font-semibold transition-colors ${
                    provider === "both"
                      ? "bg-vs-blue/30 border-vs-blue text-white"
                      : "bg-white/5 border-white/15 text-white/70 hover:bg-white/10"
                  }`}
                  data-testid="button-provider-both"
                >
                  Both
                </button>
                <button
                  type="button"
                  onClick={() => setProvider("teams")}
                  className={`flex-1 px-3 py-2 rounded-md border text-[12px] font-semibold transition-colors ${
                    provider === "teams"
                      ? "bg-[#5b5fc7]/30 border-[#5b5fc7] text-white"
                      : "bg-white/5 border-white/15 text-white/70 hover:bg-white/10"
                  }`}
                  data-testid="button-provider-teams"
                >
                  Teams
                </button>
              </div>
              <div className="text-[10px] text-white/40 mt-1">
                {provider === "bulldog" && "Bulldog Meet only — no external links."}
                {provider === "both" && "Bulldog Meet + parallel Microsoft Teams link."}
                {provider === "teams" && "Primary: Microsoft Teams. Bulldog link still available as fallback."}
              </div>
            </div>
          )}

          {/* Start time */}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[hsl(0_0%_65%)] font-mono">Start time</span>
            <input
              type="datetime-local"
              value={startLocal}
              onChange={(e) => setStartLocal(e.target.value)}
              className="bg-[hsl(220_50%_18%)] border border-[hsl(220_40%_25%)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-vs-blue-light"
              data-testid="input-schedule-start"
            />
          </label>

          {/* Channel */}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[hsl(0_0%_65%)] font-mono">Post in channel (optional)</span>
            <select
              value={channelId ?? ""}
              onChange={(e) => setChannelId(e.target.value ? Number(e.target.value) : null)}
              className="bg-[hsl(220_50%_18%)] border border-[hsl(220_40%_25%)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-vs-blue-light"
              data-testid="select-schedule-channel"
            >
              <option value="">— No channel card —</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>#{c.name}</option>
              ))}
            </select>
          </label>

          {/* Notes */}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[hsl(0_0%_65%)] font-mono">Notes (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Agenda, dial-in, etc."
              className="bg-[hsl(220_50%_18%)] border border-[hsl(220_40%_25%)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-vs-blue-light resize-none"
              data-testid="input-schedule-notes"
            />
          </label>

          {/* Attendees */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[hsl(0_0%_65%)] font-mono">Attendees</span>
            <div className="flex items-center gap-2 bg-[hsl(220_50%_18%)] border border-[hsl(220_40%_25%)] rounded-md px-2.5 py-1.5">
              <Search className="w-3.5 h-3.5 text-[hsl(0_0%_55%)] shrink-0" />
              <input
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search teammates"
                className="bg-transparent flex-1 text-sm focus:outline-none"
                data-testid="input-schedule-search"
              />
            </div>
            <div className="max-h-32 overflow-y-auto border border-[hsl(220_40%_25%)] rounded-md mt-1 divide-y divide-[hsl(220_40%_22%)]">
              {candidates.length === 0 && (
                <div className="text-[11px] text-[hsl(0_0%_55%)] px-3 py-2 italic">No matches</div>
              )}
              {candidates.slice(0, 20).map((m) => {
                const checked = selectedUserIds.has(m.id);
                return (
                  <label
                    key={m.id}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-[hsl(220_50%_18%)] cursor-pointer text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleUser(m.id)}
                      className="accent-vs-blue-light"
                      data-testid={`checkbox-schedule-user-${m.id}`}
                    />
                    <span className="truncate flex-1">{m.name}</span>
                    <span className="text-[10px] text-[hsl(0_0%_50%)] font-mono uppercase tracking-wider">{m.role}</span>
                  </label>
                );
              })}
            </div>

            {/* External phones */}
            <div className="flex items-center gap-2 mt-2">
              <input
                type="tel"
                value={phoneDraft}
                onChange={(e) => setPhoneDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPhone(); } }}
                placeholder="+1 425 555 0100"
                className="flex-1 bg-[hsl(220_50%_18%)] border border-[hsl(220_40%_25%)] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-vs-blue-light"
                data-testid="input-schedule-phone"
              />
              <button
                type="button"
                onClick={addPhone}
                className="px-2.5 py-1.5 rounded-md bg-vs-blue/15 hover:bg-vs-blue/25 border border-vs-blue/40 text-[11px] font-semibold flex items-center gap-1"
                data-testid="button-schedule-add-phone"
              >
                <Plus className="w-3 h-3" /> Phone
              </button>
            </div>
            {extraPhones.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {extraPhones.map((p) => (
                  <span key={p} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-vs-blue/15 border border-vs-blue/40 text-[11px]">
                    {p}
                    <button
                      type="button"
                      onClick={() => setExtraPhones((prev) => prev.filter((x) => x !== p))}
                      className="text-[hsl(0_0%_70%)] hover:text-vs-red"
                      aria-label={`Remove ${p}`}
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* External emails */}
            <div className="flex items-center gap-2 mt-2">
              <input
                type="email"
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEmail(); } }}
                placeholder="guest@example.com"
                className="flex-1 bg-[hsl(220_50%_18%)] border border-[hsl(220_40%_25%)] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-vs-blue-light"
                data-testid="input-schedule-email"
              />
              <button
                type="button"
                onClick={addEmail}
                className="px-2.5 py-1.5 rounded-md bg-vs-blue/15 hover:bg-vs-blue/25 border border-vs-blue/40 text-[11px] font-semibold flex items-center gap-1"
                data-testid="button-schedule-add-email"
              >
                <Plus className="w-3 h-3" /> Email
              </button>
            </div>
            {extraEmails.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {extraEmails.map((p) => (
                  <span key={p} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-vs-green/15 border border-vs-green/40 text-[11px]">
                    {p}
                    <button
                      type="button"
                      onClick={() => setExtraEmails((prev) => prev.filter((x) => x !== p))}
                      className="text-[hsl(0_0%_70%)] hover:text-vs-red"
                      aria-label={`Remove ${p}`}
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {err && (
            <div className="text-xs text-vs-red border border-vs-red/40 bg-vs-red/10 rounded-md px-3 py-2">{err}</div>
          )}

          <div className="flex items-center gap-2 pt-2 border-t border-[hsl(220_40%_22%)]">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-3 py-2 rounded-md bg-[hsl(220_50%_18%)] hover:bg-[hsl(220_50%_22%)] border border-[hsl(220_40%_25%)] text-sm"
              data-testid="button-schedule-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setErr(null);
                if (!title.trim()) { setErr("Title required"); return; }
                if (selectedUserIds.size === 0 && extraPhones.length === 0 && extraEmails.length === 0) {
                  setErr("Add at least one attendee"); return;
                }
                createMut.mutate();
              }}
              disabled={createMut.isPending}
              className="flex-1 px-3 py-2 rounded-md bg-vs-blue-light/20 hover:bg-vs-blue-light/30 border border-vs-blue-light/40 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
              data-testid="button-schedule-submit"
            >
              {createMut.isPending ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Scheduling…</>
              ) : (
                <>Schedule call</>
              )}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// MeetingsListDialog — shows upcoming + recent calls visible to the user.
// Lets organizer cancel, anyone RSVP, anyone download ICS.
// ─────────────────────────────────────────────────────────────────────────

interface ApiScheduledCall {
  id: number;
  orgId: number;
  organizerId: number;
  channelId: number | null;
  title: string;
  notes: string | null;
  kind: "voice" | "video";
  startAt: number;
  endAt: number;
  status: "scheduled" | "started" | "cancelled" | "completed";
  roomName: string;
  meetingCode: string | null;
  invitees: Array<{
    id: number;
    userId: number | null;
    externalPhone: string | null;
    externalEmail: string | null;
    response: "pending" | "yes" | "no" | "maybe";
  }>;
}

export function MeetingsListDialog({
  open, onClose, orgMembers, me, onOpenScheduler,
}: {
  open: boolean;
  onClose: () => void;
  orgMembers: ApiUser[];
  me: ApiUser;
  onOpenScheduler: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const memberById = useMemo(() => new Map(orgMembers.map((m) => [m.id, m])), [orgMembers]);

  const q = useQuery<{ calls: ApiScheduledCall[] }>({
    queryKey: ["/api/scheduled-calls"],
    queryFn: () => apiRequest("GET", "/api/scheduled-calls"),
    enabled: open,
  });

  const rsvpMut = useMutation({
    mutationFn: async ({ id, response }: { id: number; response: "yes" | "no" | "maybe" }) =>
      apiRequest("POST", `/api/scheduled-calls/${id}/rsvp`, { response }),
    onSuccess: (_data, { response }) => {
      qc.invalidateQueries({ queryKey: ["/api/scheduled-calls"] });
      const label = response === "yes" ? "Yes" : response === "no" ? "No" : "Maybe";
      toast({ title: `RSVP ${label} recorded` });
    },
    onError: (err: any) => {
      toast({ title: "RSVP failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const cancelMut = useMutation({
    mutationFn: async (id: number) =>
      apiRequest("POST", `/api/scheduled-calls/${id}/cancel`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/scheduled-calls"] });
      toast({ title: "Meeting cancelled" });
    },
    onError: (err: any) => toast({ title: "Cancel failed", description: err?.message ?? "Unknown error", variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) =>
      apiRequest("DELETE", `/api/scheduled-calls/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/scheduled-calls"] });
      toast({ title: "Meeting deleted" });
    },
    onError: (err: any) => toast({ title: "Delete failed", description: err?.message ?? "Unknown error", variant: "destructive" }),
  });

  if (!open) return null;

  const calls = q.data?.calls ?? [];
  const upcoming = calls.filter((c) => c.status !== "cancelled" && c.endAt > Date.now())
    .sort((a, b) => a.startAt - b.startAt);
  const past = calls.filter((c) => c.endAt <= Date.now() || c.status === "cancelled")
    .sort((a, b) => b.startAt - a.startAt);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto bg-[hsl(220_55%_13%)] border-[hsl(220_40%_25%)] text-white">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between font-display tracking-wide">
            <span className="flex items-center gap-2">
              <CalIcon className="w-4 h-4 text-vs-blue-light" />
              Meetings
            </span>
            <button
              type="button"
              onClick={onOpenScheduler}
              className="px-3 py-1.5 rounded-md bg-vs-blue-light/20 hover:bg-vs-blue-light/30 border border-vs-blue-light/40 text-xs font-semibold flex items-center gap-1.5"
              data-testid="button-meetings-new"
            >
              <Plus className="w-3 h-3" /> New
            </button>
          </DialogTitle>
          <DialogDescription className="text-[11px] text-[hsl(0_0%_65%)] font-mono uppercase tracking-wider">
            Upcoming and recent Bulldog calls
          </DialogDescription>
        </DialogHeader>

        {q.isLoading && (
          <div className="flex items-center gap-2 text-sm text-[hsl(0_0%_65%)] py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}

        {!q.isLoading && upcoming.length === 0 && past.length === 0 && (
          <div className="text-sm text-[hsl(0_0%_65%)] py-6 text-center">
            No meetings yet. Tap <strong>New</strong> to schedule one.
          </div>
        )}

        <div className="flex flex-col gap-4 mt-3">
          {upcoming.length > 0 && (
            <Section label="Upcoming">
              {upcoming.map((c) => (
                <MeetingRow
                  key={c.id}
                  call={c}
                  me={me}
                  memberById={memberById}
                  onRsvp={(response) => rsvpMut.mutate({ id: c.id, response })}
                  onCancel={() => { if (confirm(`Cancel "${c.title}"?`)) cancelMut.mutate(c.id); }}
                  onDelete={() => { if (confirm(`Permanently delete "${c.title}"? This cannot be undone.`)) deleteMut.mutate(c.id); }}
                />
              ))}
            </Section>
          )}
          {past.length > 0 && (
            <Section label="Past">
              {past.slice(0, 20).map((c) => (
                <MeetingRow
                  key={c.id}
                  call={c}
                  me={me}
                  memberById={memberById}
                  onRsvp={() => {}}
                  onCancel={() => {}}
                  onDelete={() => { if (confirm(`Permanently delete "${c.title}"? This cannot be undone.`)) deleteMut.mutate(c.id); }}
                  readOnly
                />
              ))}
            </Section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] uppercase tracking-wider text-[hsl(0_0%_55%)] font-mono px-1">{label}</div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function MeetingRow({
  call, me, memberById, onRsvp, onCancel, onDelete, readOnly,
}: {
  call: ApiScheduledCall;
  me: ApiUser;
  memberById: Map<number, ApiUser>;
  onRsvp: (response: "yes" | "no" | "maybe") => void;
  onCancel: () => void;
  onDelete: () => void;
  readOnly?: boolean;
}) {
  const organizer = memberById.get(call.organizerId);
  const myInvitee = call.invitees.find((i) => i.userId === me.id);
  const iAmOrganizer = call.organizerId === me.id;
  const iAmAdmin = me.role === "admin";
  const canDelete = iAmOrganizer || iAmAdmin;
  const startDate = new Date(call.startAt);
  const whenLabel = startDate.toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  const cancelled = call.status === "cancelled";

  return (
    <div className={`border border-[hsl(220_40%_22%)] rounded-lg p-3 ${cancelled ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {call.kind === "video" ? <Video className="w-3.5 h-3.5 text-vs-blue-light shrink-0" /> : <Mic className="w-3.5 h-3.5 text-vs-green shrink-0" />}
            <div className="text-sm font-semibold truncate">{call.title}</div>
            {cancelled && <span className="text-[10px] text-vs-red font-mono uppercase tracking-wider">Cancelled</span>}
          </div>
          <div className="text-[11px] text-[hsl(0_0%_65%)] mt-0.5">
            {whenLabel} · {organizer?.name ?? "—"} · {call.invitees.length} invitee{call.invitees.length === 1 ? "" : "s"}
          </div>
          {call.invitees.length > 0 && (() => {
            const shortName = (full: string) => {
              const parts = full.trim().split(/\s+/).filter(Boolean);
              if (parts.length <= 1) return parts[0] ?? "Guest";
              return `${parts[0]} ${parts[parts.length - 1][0]}.`;
            };
            const nameOf = (inv: ApiScheduledCall["invitees"][number]) => {
              if (inv.userId != null) return shortName(memberById.get(inv.userId)?.name ?? `User ${inv.userId}`);
              if (inv.externalEmail) return inv.externalEmail.split("@")[0];
              if (inv.externalPhone) return `…${inv.externalPhone.slice(-4)}`;
              return "Guest";
            };
            const nameList = (arr: typeof call.invitees, max = 3) => {
              const names = arr.map(nameOf);
              return names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} +${names.length - max}`;
            };
            const by = (r: string) => call.invitees.filter((i) => i.response === r);
            const accepted = by("yes"), declined = by("no"), maybe = by("maybe"), noReply = by("pending");
            const segs: Array<{ text: string; cls: string }> = [];
            if (accepted.length) segs.push({ text: `Accepted: ${nameList(accepted)}`, cls: "text-vs-green" });
            if (declined.length) segs.push({ text: `Declined: ${nameList(declined)}`, cls: "text-[hsl(0_0%_60%)]" });
            if (maybe.length) segs.push({ text: `Maybe: ${nameList(maybe)}`, cls: "text-vs-blue-light" });
            if (noReply.length) segs.push({ text: `No reply: ${noReply.length}`, cls: "text-[hsl(0_0%_55%)]" });
            return (
              <div className="text-[11px] mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5" data-testid={`meeting-rsvp-summary-${call.id}`}>
                {segs.map((s, idx) => (
                  <span key={s.text} className={s.cls}>
                    {idx > 0 && <span className="text-[hsl(0_0%_35%)] mr-1.5">·</span>}
                    {s.text}
                  </span>
                ))}
              </div>
            );
          })()}
          {call.notes && (
            <div className="text-[11px] text-[hsl(0_0%_75%)] mt-1 line-clamp-2">{call.notes}</div>
          )}
        </div>
        {(cancelled ? canDelete : !readOnly) && (
          <div className="flex items-center gap-1.5 shrink-0">
            {!cancelled && call.meetingCode && (() => {
              const teamsPrimary = (call as any).provider === "teams" && (call as any).teamsJoinUrl;
              const bulldogClass = teamsPrimary
                ? "px-3 py-1.5 rounded-md bg-[#5b5fc7] hover:bg-[#4a4ea8] text-[11px] font-bold flex items-center gap-1.5 text-white shadow-sm"
                : "px-3 py-1.5 rounded-md bg-vs-green hover:bg-vs-green/85 text-[11px] font-bold flex items-center gap-1.5 text-white shadow-sm";
              const teamsClass = teamsPrimary
                ? "px-3 py-1.5 rounded-md bg-vs-green hover:bg-vs-green/85 text-[11px] font-bold flex items-center gap-1.5 text-white shadow-sm"
                : "px-3 py-1.5 rounded-md bg-[#5b5fc7] hover:bg-[#4a4ea8] text-[11px] font-bold flex items-center gap-1.5 text-white shadow-sm";
              return (
                <>
                  {teamsPrimary && (call as any).teamsJoinUrl && (
                    <a
                      href={(call as any).teamsJoinUrl as string}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={teamsClass}
                      data-testid={`button-meeting-teams-${call.id}`}
                      title="Join via Microsoft Teams"
                    >
                      <Video className="w-3 h-3" /> Teams
                    </a>
                  )}
                  <a
                    href={`/m/${call.meetingCode}`}
                    className={bulldogClass}
                    data-testid={`button-meeting-join-${call.id}`}
                  >
                    <Video className="w-3 h-3" /> {teamsPrimary ? "Bulldog" : "Join"}
                  </a>
                  {!teamsPrimary && (call as any).teamsJoinUrl && (
                    <a
                      href={(call as any).teamsJoinUrl as string}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={teamsClass}
                      data-testid={`button-meeting-teams-${call.id}`}
                      title="Join via Microsoft Teams"
                    >
                      <Video className="w-3 h-3" /> Teams
                    </a>
                  )}
                </>
              );
            })()}
            {!cancelled && iAmOrganizer && (
              <button
                type="button"
                onClick={onCancel}
                className="px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-[10px] font-bold uppercase tracking-wider shadow-sm"
                data-testid={`button-meeting-cancel-${call.id}`}
              >
                Cancel
              </button>
            )}
            {!cancelled && (
              <a
                href={`/api/scheduled-calls/${call.id}/ics`}
                className="px-2.5 py-1 rounded-md bg-[hsl(220_50%_30%)] hover:bg-[hsl(220_50%_36%)] text-white text-[10px] font-bold uppercase tracking-wider shadow-sm"
                data-testid={`link-meeting-ics-${call.id}`}
              >
                .ics
              </a>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={onDelete}
                title="Permanently delete this meeting"
                className="px-2 py-1 rounded-md bg-vs-red hover:bg-vs-red/85 text-white text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 shadow-sm"
                data-testid={`button-meeting-delete-${call.id}`}
              >
                <Trash2 className="w-3 h-3" /> Delete
              </button>
            )}
          </div>
        )}
      </div>
      {!readOnly && !cancelled && myInvitee && (
        <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-[hsl(220_40%_22%)]">
          <span className="text-[10px] uppercase tracking-wider text-[hsl(0_0%_55%)] font-mono">RSVP:</span>
          {(["yes", "no", "maybe"] as const).map((r) => {
            const active = myInvitee.response === r;
            const color = r === "yes" ? "vs-green" : r === "no" ? "vs-red" : "vs-blue-light";
            return (
              <button
                key={r}
                type="button"
                onClick={() => onRsvp(r)}
                className={`px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider border ${
                  active
                    ? `bg-${color}/20 border-${color}/60 text-white`
                    : "bg-transparent border-[hsl(220_40%_25%)] text-[hsl(0_0%_70%)] hover:text-white"
                }`}
                data-testid={`button-meeting-rsvp-${call.id}-${r}`}
              >
                {r === "yes" ? "Yes" : r === "no" ? "No" : "Maybe"}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Convert a Date to the value format used by <input type="datetime-local">. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse a datetime-local string back to a UTC epoch in ms. Returns null on invalid. */
function parseLocalInputValue(s: string): number | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getTime();
}
