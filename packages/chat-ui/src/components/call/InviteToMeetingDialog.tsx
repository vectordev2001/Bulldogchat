// Mid-meeting invite dialog.
//
// Any participant who is an org member can fire off SMS invites (and copy a
// shareable link) for additional people while a meeting is live. This is the
// "we need X in this conversation right now" affordance — without it the host
// has to bounce out, find the person, and pre-invite them.
//
// Backend: POST /api/meetings/:code/invite. The server runs the same TCPA
// consent gate + cross-org filter as the create endpoint, so the UI can be
// permissive without worrying about safety.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Loader2, Mail, Phone, Search } from "lucide-react";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import { useToast } from "../../hooks/use-toast";
import { apiRequest } from "../../lib/queryClient";
import { useAuth } from "../../lib/auth-context";
import type { ApiUser } from "../../types/api";

interface InviteToMeetingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  code: string;
  meetingTitle?: string;
}

// Render-time only — a tiny smoke test on E.164-ish shapes. The server is the
// source of truth (it calls normalizeE164), so this is purely to disable Send
// when nothing parseable was entered.
function looksLikePhone(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  // Allow +, digits, spaces, dashes, parens, dots. Need ≥ 7 digits.
  const digits = trimmed.replace(/[^\d]/g, "");
  return digits.length >= 7;
}

export function InviteToMeetingDialog({ open, onOpenChange, code, meetingTitle }: InviteToMeetingDialogProps) {
  const { toast } = useToast();
  const { user: authedUser } = useAuth();
  const joinUrl = `${window.location.origin}/m/${code}`;

  // Org members — same query the rest of the app uses. enabled-gated so we
  // don't fetch until the dialog is actually opened.
  const orgMembersQ = useQuery<ApiUser[]>({
    queryKey: ["/api/org/members"],
    enabled: open,
  });

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [phonesText, setPhonesText] = useState("");
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);

  // Filter out: the caller themselves (you can't invite yourself), and any
  // member without a phone number — SMS is the only delivery channel for now,
  // so showing phone-less members would be a silent skip and feel broken.
  const eligibleMembers = useMemo(() => {
    const all = orgMembersQ.data ?? [];
    return all.filter((m) => m.id !== authedUser?.id && !!m.phone && !m.deactivated);
  }, [orgMembersQ.data, authedUser?.id]);

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return eligibleMembers;
    return eligibleMembers.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q) ||
        (m.title ?? "").toLowerCase().includes(q),
    );
  }, [eligibleMembers, search]);

  // Parse the textarea into a clean list of phone-like strings. Split on
  // commas / newlines / semicolons — whatever the user pastes.
  const parsedPhones = useMemo(() => {
    return phonesText
      .split(/[\n,;]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }, [phonesText]);

  const validPhones = useMemo(() => parsedPhones.filter(looksLikePhone), [parsedPhones]);
  const invalidCount = parsedPhones.length - validPhones.length;

  const toggleMember = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalToSend = selectedIds.size + validPhones.length;
  const canSend = !sending && totalToSend > 0;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      toast({ title: "Link copied", description: joinUrl });
    } catch {
      toast({ title: "Couldn't copy link", description: "Select the URL manually", variant: "destructive" });
    }
  };

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const result = await apiRequest<{ invitesSent: { sms: number; skipped: number }; joinUrl: string }>(
        "POST",
        `/api/meetings/${code}/invite`,
        {
          inviteeUserIds: Array.from(selectedIds),
          inviteeExternalPhones: validPhones,
        },
      );
      const { sms, skipped } = result.invitesSent;
      const parts: string[] = [];
      if (sms > 0) parts.push(`${sms} text${sms === 1 ? "" : "s"} sent`);
      if (skipped > 0) parts.push(`${skipped} skipped`);
      toast({
        title: sms > 0 ? "Invites sent" : "Nothing was sent",
        description: parts.length > 0 ? parts.join(" · ") : "No eligible recipients",
        variant: sms > 0 ? "default" : "destructive",
      });
      if (sms > 0) {
        setSelectedIds(new Set());
        setPhonesText("");
        onOpenChange(false);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Try again";
      toast({ title: "Couldn't send invites", description: msg, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="dialog-invite-to-meeting">
        <DialogHeader>
          <DialogTitle>Invite to meeting</DialogTitle>
          {meetingTitle && (
            <p className="text-sm text-muted-foreground">{meetingTitle}</p>
          )}
        </DialogHeader>

        {/* Copy link — always works, even when SMS isn't configured. */}
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <Mail size={16} className="shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground" data-testid="invite-join-url">
            {joinUrl}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyLink}
            data-testid="button-copy-link"
            className="shrink-0"
          >
            <Copy size={14} className="mr-1.5" />
            Copy
          </Button>
        </div>

        {/* Org members — checklist with a quick search filter. */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">Teammates</Label>
            {selectedIds.size > 0 && (
              <span className="text-xs text-muted-foreground" data-testid="text-member-count">
                {selectedIds.size} selected
              </span>
            )}
          </div>

          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, email, or title"
              className="pl-8"
              data-testid="input-member-search"
            />
          </div>

          <ScrollArea className="h-48 rounded-md border border-border">
            {orgMembersQ.isLoading ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <Loader2 size={14} className="mr-2 animate-spin" />
                Loading teammates…
              </div>
            ) : filteredMembers.length === 0 ? (
              <div className="flex h-full items-center justify-center px-4 py-6 text-center text-sm text-muted-foreground">
                {eligibleMembers.length === 0
                  ? "No teammates with phone numbers to invite"
                  : "No matches for your search"}
              </div>
            ) : (
              <div className="p-1">
                {filteredMembers.map((m) => (
                  <label
                    key={m.id}
                    className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover-elevate"
                    data-testid={`row-member-${m.id}`}
                  >
                    <Checkbox
                      checked={selectedIds.has(m.id)}
                      onCheckedChange={() => toggleMember(m.id)}
                      data-testid={`checkbox-member-${m.id}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{m.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {m.title ? `${m.title} · ` : ""}{m.email}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Free-form phones. Helpful for site contacts / subs / one-offs who
            aren't org members. Server skips numbers that fail consent. */}
        <div className="space-y-2">
          <Label htmlFor="invite-phones" className="text-sm font-medium">
            Phone numbers
            <span className="ml-1 font-normal text-muted-foreground">(comma or newline separated)</span>
          </Label>
          <div className="relative">
            <Phone size={14} className="absolute left-2.5 top-2.5 text-muted-foreground" />
            <textarea
              id="invite-phones"
              value={phonesText}
              onChange={(e) => setPhonesText(e.target.value)}
              placeholder="+1 555 123 4567, +1 555 987 6543"
              rows={2}
              className="flex w-full rounded-md border border-input bg-background px-8 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              data-testid="textarea-invite-phones"
            />
          </div>
          {invalidCount > 0 && (
            <p className="text-xs text-destructive" data-testid="text-invalid-phones">
              {invalidCount} entr{invalidCount === 1 ? "y looks" : "ies look"} invalid and will be skipped
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-invite">
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={!canSend} data-testid="button-send-invites">
            {sending ? (
              <>
                <Loader2 size={14} className="mr-1.5 animate-spin" />
                Sending…
              </>
            ) : (
              `Send ${totalToSend > 0 ? totalToSend : ""} invite${totalToSend === 1 ? "" : "s"}`.trim()
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
