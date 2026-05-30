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
import { useQuery } from "@tanstack/react-query";
import { Phone, Video, X, Loader2 } from "lucide-react";
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
  const [kind, setKind] = useState<"voice" | "video">(initialKind);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to the requested kind every time the dialog reopens. Keeps the
  // button the user clicked in the channel header authoritative.
  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setError(null);
      setSubmitting(false);
    }
  }, [open, initialKind]);

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
  const someSelected = selected.size > 0;

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allMembers.map((m) => m.id)));
    }
  }

  function toggleOne(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  const canSubmit = someSelected && !submitting && !active && !outgoing;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await startGroupCall({
        channelId: channel.id,
        channelName: channel.name,
        inviteeIds: Array.from(selected),
        kind,
      });
      onClose();
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
              return (
                <label
                  key={m.id}
                  className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 cursor-pointer"
                  data-testid={`row-invitee-${m.id}`}
                >
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
                    <div className="text-xs text-muted-foreground truncate">{m.email}</div>
                  </div>
                </label>
              );
            })
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
              : selected.size === 0
                ? "Pick at least one person"
                : `Ring ${selected.size} ${selected.size === 1 ? "person" : "people"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
