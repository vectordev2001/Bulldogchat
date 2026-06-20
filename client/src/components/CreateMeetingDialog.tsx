/**
 * CreateMeetingDialog
 *
 * Creates a unified meeting (POST /api/meetings) with an AI-summary
 * recipient picker. Unlike ChannelCallDialog (which rings people into a
 * LiveKit room right now), this mints a shareable /m/:code link that can
 * be sent to anyone — including external guests — and lets the host choose
 * who receives the post-meeting AI summary email:
 *
 *   • Nobody                — no summary sent
 *   • Channel members       — everyone in the linked channel
 *   • Everyone who joined   — all attendees (incl. guests with an email)
 *   • Custom list           — hand-picked org users + free-text emails
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, X, Plus, Copy, Check, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ApiChannel, ApiUser } from "@/types/api";

type SummaryPolicy = "none" | "channel_members" | "all_attendees" | "explicit";

interface Props {
  channel: ApiChannel;
  meId: number;
  open: boolean;
  onClose(): void;
}

interface CreateMeetingResponse {
  meeting: { code: string; title: string | null };
  joinUrl: string;
}

const POLICY_OPTIONS: { value: SummaryPolicy; label: string; hint: string }[] = [
  { value: "none", label: "Nobody", hint: "Don't send an AI summary" },
  { value: "channel_members", label: "Channel members", hint: `Everyone in this channel` },
  { value: "all_attendees", label: "Everyone who joined", hint: "All attendees with an email" },
  { value: "explicit", label: "Custom list", hint: "Pick specific people + emails" },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CreateMeetingDialog({ channel, meId, open, onClose }: Props) {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [policy, setPolicy] = useState<SummaryPolicy>("channel_members");
  const [allowGuests, setAllowGuests] = useState(true);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<number>>(new Set());
  const [emails, setEmails] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateMeetingResponse | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle(`Meeting in #${channel.name}`);
      setPolicy("channel_members");
      setAllowGuests(true);
      setSelectedUserIds(new Set());
      setEmails([]);
      setEmailInput("");
      setError(null);
      setSubmitting(false);
      setCreated(null);
      setCopied(false);
    }
  }, [open, channel.name]);

  const membersQ = useQuery<ApiUser[]>({
    queryKey: ["channel-members", channel.id],
    queryFn: () => apiRequest<ApiUser[]>("GET", `/api/channels/${channel.id}/members`),
    enabled: open && policy === "explicit",
    staleTime: 30_000,
  });

  const members: ApiUser[] = useMemo(
    () => (membersQ.data ?? []).filter((m) => m.id !== meId && !m.deactivated),
    [membersQ.data, meId],
  );

  function toggleUser(id: number) {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function addEmail() {
    const raw = emailInput.trim().toLowerCase();
    if (!raw) return;
    if (!EMAIL_RE.test(raw)) {
      setError("Enter a valid email address.");
      return;
    }
    if (!emails.includes(raw)) setEmails((prev) => [...prev, raw]);
    setEmailInput("");
    setError(null);
  }

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        kind: "scheduled",
        title: title.trim() || `Meeting in #${channel.name}`,
        channelId: channel.id,
        allowGuests,
        summaryEnabled: policy !== "none",
        summaryRecipientPolicy: policy,
      };
      if (policy === "explicit") {
        body.summaryRecipientUserIds = Array.from(selectedUserIds);
        body.summaryRecipientEmails = emails;
      }
      const resp = await apiRequest<CreateMeetingResponse>("POST", "/api/meetings", body);
      setCreated(resp);
    } catch (err: any) {
      const msg =
        (err && typeof err === "object" && "message" in err && String((err as any).message)) ||
        "Could not create the meeting. Try again.";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  async function copyLink() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Couldn't copy", description: created.joinUrl });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-create-meeting">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-display">
            <Sparkles className="w-4 h-4 text-primary" />
            New meeting
          </DialogTitle>
        </DialogHeader>

        {created ? (
          // ── Success: show the shareable link ──
          <div className="space-y-4" data-testid="create-meeting-success">
            <p className="text-sm text-muted-foreground">
              Your meeting is ready. Share this link — guests can join without an account.
            </p>
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
              <span className="flex-1 truncate font-mono text-sm" data-testid="text-join-url">
                {created.joinUrl}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={copyLink}
                data-testid="button-copy-join-url"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={onClose} data-testid="button-done">Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label htmlFor="meeting-title" className="text-sm font-medium">Title</label>
              <Input
                id="meeting-title"
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                className="mt-1.5"
                data-testid="input-meeting-title"
              />
            </div>

            <label className="flex items-center gap-3 cursor-pointer">
              <Checkbox
                checked={allowGuests}
                onCheckedChange={(c) => setAllowGuests(!!c)}
                data-testid="checkbox-allow-guests"
              />
              <span className="text-sm">Allow guests to join without an account</span>
            </label>

            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Sparkles className="w-3.5 h-3.5 text-primary" /> AI summary recipients
              </div>
              <div className="mt-2 space-y-1.5">
                {POLICY_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className={`flex items-start gap-3 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                      policy === opt.value
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/40"
                    }`}
                    data-testid={`radio-policy-${opt.value}`}
                  >
                    <input
                      type="radio"
                      name="summary-policy"
                      checked={policy === opt.value}
                      onChange={() => setPolicy(opt.value)}
                      className="mt-1 accent-primary"
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{opt.label}</div>
                      <div className="text-xs text-muted-foreground">{opt.hint}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {policy === "explicit" && (
              <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
                <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                  People
                </div>
                <div className="max-h-40 overflow-y-auto rounded-md border border-border divide-y divide-border/60">
                  {membersQ.isLoading ? (
                    <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                    </div>
                  ) : members.length === 0 ? (
                    <div className="py-4 text-center text-sm text-muted-foreground">
                      No one else in this channel.
                    </div>
                  ) : (
                    members.map((m) => (
                      <label
                        key={m.id}
                        className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 cursor-pointer"
                        data-testid={`row-recipient-${m.id}`}
                      >
                        <Checkbox
                          checked={selectedUserIds.has(m.id)}
                          onCheckedChange={() => toggleUser(m.id)}
                          data-testid={`checkbox-recipient-${m.id}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm truncate">{m.name}</div>
                          <div className="text-xs text-muted-foreground truncate">{m.email}</div>
                        </div>
                      </label>
                    ))
                  )}
                </div>

                <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                  Or add email addresses
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="email"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEmail(); } }}
                    placeholder="name@example.com"
                    className="h-9"
                    data-testid="input-recipient-email"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addEmail}
                    disabled={!emailInput.trim()}
                    data-testid="button-add-recipient-email"
                  >
                    <Plus className="w-3.5 h-3.5 mr-1" /> Add
                  </Button>
                </div>
                {emails.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {emails.map((e) => (
                      <span
                        key={e}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-primary/15 border border-primary/40 text-primary text-[11px] font-mono"
                        data-testid={`chip-recipient-email-${e}`}
                      >
                        {e}
                        <button
                          type="button"
                          onClick={() => setEmails((prev) => prev.filter((x) => x !== e))}
                          className="hover:opacity-80"
                          aria-label={`Remove ${e}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {error && (
              <div
                className="text-xs text-destructive bg-destructive/10 border border-destructive/40 rounded px-2 py-1.5"
                data-testid="text-create-meeting-error"
              >
                {error}
              </div>
            )}

            <DialogFooter className="gap-2">
              <Button variant="ghost" onClick={onClose} disabled={submitting} data-testid="button-cancel-create-meeting">
                Cancel
              </Button>
              <Button onClick={submit} disabled={submitting} data-testid="button-create-meeting">
                {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Sparkles className="w-4 h-4 mr-1" />}
                {submitting ? "Creating…" : "Create meeting"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
