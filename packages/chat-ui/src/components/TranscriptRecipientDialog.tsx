// Phase 2.3 — Transcript recipient picker.
//
// Pops up after the AI clerk finishes processing a meeting and the note
// lands in 'awaiting_recipients'. The host (who started the clerk) chooses
// which attendees get the email transcript and clicks Send, or Skip to
// suppress the email entirely.
//
// Lifecycle:
//   1. Parent polls /api/channels/:id/meeting-notes (it already does for
//      other clerk status reads).
//   2. When it sees status='awaiting_recipients' for a note whose
//      started_by_user_id === current user, it opens this dialog.
//   3. We fetch GET /api/meeting-notes/:id/recipients on mount → checkbox
//      list. Present-in-call attendees are pre-checked.
//   4. POST /api/meeting-notes/:id/send-summary with { recipientUserIds }
//      or { skip: true }. On 200 we close; parent's poll picks up
//      status='uploaded' and stops re-opening the modal.

import { useEffect, useMemo, useState } from "react";
import { Loader2, Mail, MailX, Users } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { apiRequest, queryClient } from "../lib/queryClient";
import { useMutation, useQuery } from "@tanstack/react-query";

interface RecipientCandidate {
  userId: number;
  name: string;
  email: string;
  present: boolean;
}

interface Props {
  noteId: number;
  // Title of the meeting note (rendered in the header). The parent has this
  // from the polled note row, so we accept it as a prop instead of refetching.
  title?: string | null;
  open: boolean;
  onClose: () => void;
  // Channel id used to invalidate the polling query after a send/skip so the
  // parent immediately observes the new 'uploaded' status.
  channelId: number;
}

export function TranscriptRecipientDialog({ noteId, title, open, onClose, channelId }: Props) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recipientsQ = useQuery<{ candidates: RecipientCandidate[] }>({
    queryKey: ["/api/meeting-notes", noteId, "recipients"],
    enabled: open && !!noteId,
    staleTime: 0,
  });

  const candidates = recipientsQ.data?.candidates ?? [];

  // Pre-check the "present in call" attendees on first load. We only do this
  // once (until the user touches a checkbox) so re-opens don't trample manual
  // selections, and so the default never drops a row the host already toggled.
  useEffect(() => {
    if (touched) return;
    if (!recipientsQ.data) return;
    const next = new Set<number>();
    for (const c of recipientsQ.data.candidates) {
      if (c.present) next.add(c.userId);
    }
    setSelectedIds(next);
  }, [recipientsQ.data, touched]);

  const sendMutation = useMutation({
    mutationFn: async (payload: { recipientUserIds?: number[]; skip?: boolean }) => {
      return apiRequest<{ ok: boolean; status: string; delivered?: number; reason?: string }>(
        "POST",
        `/api/meeting-notes/${noteId}/send-summary`,
        payload,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channelId, "meeting-notes"] });
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message || "Failed to send transcript");
    },
  });

  const toggle = (userId: number) => {
    setTouched(true);
    setError(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const selectAll = () => {
    setTouched(true);
    setError(null);
    setSelectedIds(new Set(candidates.map((c) => c.userId)));
  };

  const clearAll = () => {
    setTouched(true);
    setError(null);
    setSelectedIds(new Set());
  };

  const presentCount = useMemo(
    () => candidates.filter((c) => c.present).length,
    [candidates],
  );

  const handleSend = () => {
    setError(null);
    sendMutation.mutate({ recipientUserIds: Array.from(selectedIds) });
  };

  const handleSkip = () => {
    setError(null);
    sendMutation.mutate({ skip: true });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !sendMutation.isPending) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        data-testid="dialog-transcript-recipients"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="w-5 h-5 text-vs-blue-light" />
            Send AI transcript
          </DialogTitle>
          <DialogDescription>
            {title ? <>“{title}” is ready. </> : null}
            Pick who should receive the AI summary by email. The note itself
            stays in the channel either way.
          </DialogDescription>
        </DialogHeader>

        {recipientsQ.isLoading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading attendees…
          </div>
        ) : recipientsQ.isError ? (
          <div className="py-4 text-sm text-[hsl(var(--vs-accent))]">
            Couldn't load attendees: {(recipientsQ.error as Error)?.message ?? "unknown error"}
          </div>
        ) : candidates.length === 0 ? (
          <div className="py-4 text-sm text-muted-foreground">
            No attendees with email addresses to choose from.
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5" />
                {presentCount} in call · {candidates.length - presentCount} other channel members
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={selectAll}
                  className="text-vs-blue-light hover:underline"
                  data-testid="button-select-all-recipients"
                >
                  Select all
                </button>
                <span className="text-muted-foreground/50">·</span>
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-vs-blue-light hover:underline"
                  data-testid="button-clear-recipients"
                >
                  Clear
                </button>
              </div>
            </div>

            <div
              className="max-h-72 overflow-y-auto rounded-md border border-border bg-background/40 divide-y divide-border"
              data-testid="list-recipient-candidates"
            >
              {candidates.map((c) => {
                const id = `recipient-${c.userId}`;
                const checked = selectedIds.has(c.userId);
                return (
                  <label
                    key={c.userId}
                    htmlFor={id}
                    className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/40"
                    data-testid={`item-recipient-${c.userId}`}
                  >
                    <Checkbox
                      id={id}
                      checked={checked}
                      onCheckedChange={() => toggle(c.userId)}
                      data-testid={`checkbox-recipient-${c.userId}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{c.name}</div>
                      <div className="text-xs text-muted-foreground truncate">{c.email}</div>
                    </div>
                    {c.present ? (
                      <span className="text-[10px] uppercase tracking-wide font-semibold text-vs-blue-light bg-vs-blue/10 px-1.5 py-0.5 rounded">
                        In call
                      </span>
                    ) : (
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        Channel
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </>
        )}

        {error && (
          <div className="text-sm text-[hsl(var(--vs-accent))]" data-testid="text-recipient-error">
            {error}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={handleSkip}
            disabled={sendMutation.isPending}
            data-testid="button-skip-transcript"
          >
            <MailX className="w-4 h-4 mr-1.5" />
            Don't send
          </Button>
          <Button
            onClick={handleSend}
            disabled={sendMutation.isPending || selectedIds.size === 0 || recipientsQ.isLoading}
            data-testid="button-send-transcript"
          >
            {sendMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <Mail className="w-4 h-4 mr-1.5" />
            )}
            Send to {selectedIds.size || 0}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
