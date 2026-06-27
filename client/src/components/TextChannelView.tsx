import { Hash, Pin, Plus, Smile, Paperclip, Send, Users, Search, Loader2, MessageSquare, X, Reply, Phone, Video, ClipboardList, MapPin, FileText, AlertTriangle, Link2, Unlink, Lock, Unlock, UserCog, PenLine, CheckCircle2, Trash2, Calendar as CalendarIcon, Mic, Ban, Check, HelpCircle, MoreHorizontal, ChevronDown, Headphones, Sparkles } from "lucide-react";
import { ChannelCallDialog } from "@/components/ChannelCallDialog";
import { CreateMeetingDialog } from "@/components/CreateMeetingDialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ActionPill } from "@/components/ui/action-pill";
import { useCalls } from "@/lib/CallContext";
import { Avatar } from "./Avatar";
import { useState, useRef, useEffect, KeyboardEvent, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { ApiChannel, ApiMessage, ApiUser, UserRole, ApiSystemMessageMeta, ApiWorkObjectSystemMessageMeta, ApiScheduledCallSystemMessageMeta, ApiMeetingSummarySystemMessageMeta } from "@/types/api";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAttachmentUploader, ATTACH_ACCEPT } from "@/hooks/use-attachment-uploader";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ThreadPanel } from "./ThreadPanel";
import { SearchModal } from "./SearchModal";
import { MessageAttachments } from "./MessageAttachments";
import { ContractBanner } from "./ContractBanner";
import { MeetingNotesHistory } from "./MeetingNotesHistory";

interface Props {
  channel: ApiChannel;
  messages: ApiMessage[];
  loading: boolean;
  me: ApiUser;
  orgMembers: ApiUser[];
  membersOpen?: boolean;
  onToggleMembers?: () => void;
  workObjectsOpen?: boolean;
  onToggleWorkObjects?: () => void;
  onSlashSchedule?: (titleHint: string) => void;
}

const ROLE_COLOR: Record<UserRole, string> = {
  admin: "text-[hsl(var(--vs-accent))]",
  manager: "text-vs-blue-light",
  user: "text-vs-green",
};
const ROLE_LABEL: Record<UserRole, string> = {
  admin: "Admin", manager: "Manager", user: "User",
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const h = d.getHours() % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = d.getHours() >= 12 ? "PM" : "AM";
  const time = `${h}:${m} ${ampm}`;
  if (sameDay) return `Today at ${time}`;
  if (isYesterday) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
}

interface MentionMatch {
  query: string;
  startIdx: number;
}

export function TextChannelView({ channel, messages, loading, me, orgMembers, membersOpen, onToggleMembers, workObjectsOpen, onToggleWorkObjects, onSlashSchedule }: Props) {
  const [draft, setDraft] = useState("");
  const { pending: pendingAtts, addFiles, remove: removePending, clear: clearPending, uploading, readyIds, atCapacity } = useAttachmentUploader({ max: 8 });
  const [threadParent, setThreadParent] = useState<ApiMessage | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0);
  const [callDialog, setCallDialog] = useState<null | "voice" | "video">(null);
  const [createMeetingOpen, setCreateMeetingOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const { active: activeCall, outgoing: outgoingCall, startGroupCall } = useCalls();
  const callBusy = !!activeCall || !!outgoingCall;
  const [huddleStarting, setHuddleStarting] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pinnedBannerRef = useRef<HTMLDivElement>(null);

  const scrollToPinned = useCallback(() => {
    // Pinned banner sits at the top of the message area; flash + scroll the
    // message list to top so the banner is in view and the user notices it.
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    const el = pinnedBannerRef.current;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("ring-2", "ring-vs-red");
      window.setTimeout(() => {
        el.classList.remove("ring-2", "ring-vs-red");
      }, 1200);
    }
  }, []);

  const sendMutation = useMutation({
    mutationFn: async (payload: { content: string; attachmentIds?: string[] }) =>
      apiRequest<ApiMessage>("POST", `/api/channels/${channel.id}/messages`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channel.id, "messages"] });
    },
  });

  const { toast: channelToast } = useToast();

  // Start a channel huddle: reuse the battle-tested group-call overlay (the
  // caller drops straight into the LiveKit room) and post a shareable
  // join-link message so anyone — including external guests — can hop in via
  // the public /m/:code page.
  const startHuddle = useCallback(async () => {
    if (callBusy || huddleStarting) return;
    setHuddleStarting(true);
    try {
      const { joinUrl } = await startGroupCall({
        channelId: channel.id,
        channelName: channel.name,
        inviteeIds: [],
        kind: "voice",
      });
      if (joinUrl) {
        sendMutation.mutate({
          content: `${me.name} started a huddle — join here: ${joinUrl}`,
        });
      }
    } catch {
      channelToast({ title: "Couldn't start the huddle", description: "Please try again.", variant: "destructive" });
    } finally {
      setHuddleStarting(false);
    }
  }, [callBusy, huddleStarting, startGroupCall, channel.id, channel.name, me.name, sendMutation, channelToast]);

  // Phase 1.9.36 — admin-only "clear channel". Double-confirmed because
  // the operation tombstones every message in the channel. Server fans
  // out SSE message-update + message-delete per id so live clients
  // re-render rows as tombstones in real time.
  const clearChannelMut = useMutation({
    mutationFn: async () => {
      const url = `/api/channels/${channel.id}/messages`;
      const method = "DELETE";
      // Verbose diagnostics: the original report was "nothing happened" with no
      // visible toast. Log the request so we can confirm in the iOS WebView
      // console (Safari → Develop) that the call actually fires and see the
      // server's response. apiRequest throws on non-2xx with .status/.body.
      console.log(`[clearChannel] →`, { method, url, channelId: channel.id });
      try {
        const data = await apiRequest<{ ok: true; clearedCount: number }>(method, url);
        console.log(`[clearChannel] ← ok`, data);
        return data;
      } catch (err: any) {
        console.error(`[clearChannel] ← error`, {
          message: err?.message,
          status: err?.status,
          body: err?.body,
          name: err?.name,
        });
        throw err;
      }
    },
    onSuccess: (data) => {
      console.log(`[clearChannel] success — clearedCount=${data?.clearedCount ?? 0}`);
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channel.id, "messages"] });
      channelToast({
        title: "Channel cleared",
        description: `${data?.clearedCount ?? 0} message${data?.clearedCount === 1 ? "" : "s"} marked as deleted.`,
      });
    },
    onError: (err: any) => {
      // Always surface a meaningful message. apiRequest throws `${status}: ${text}`
      // for HTTP errors (carrying .status/.body), but a network failure (offline,
      // dropped WebView connection — the most likely cause of "nothing happened"
      // on a backgrounded iOS app) rejects with a bare TypeError whose message is
      // "Failed to fetch". Compose the richest text we can from whatever we got.
      const status = err?.status ? `HTTP ${err.status}` : "Network error";
      const bodyMsg = err?.body?.message;
      const description = bodyMsg || err?.message || "Failed to fetch — the request did not reach the server (check connection).";
      channelToast({
        title: `Clear failed (${status})`,
        description,
        variant: "destructive",
        duration: 8000,
      });
    },
  });

  const onClearChannel = () => {
    if (clearChannelMut.isPending) return;
    if (!window.confirm(
      `Clear ALL messages in #${channel.name}?\n\nThis tombstones every message in the channel. Meeting notes, scheduled meetings, and jobs are kept. This can't be undone.`
    )) return;
    if (!window.confirm(
      `Final confirmation — wipe every message in #${channel.name}?`
    )) return;
    clearChannelMut.mutate();
  };

  // Global Cmd+K / Ctrl+K to open search
  useEffect(() => {
    const h = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, channel.id]);

  // Scroll-affordance state. Shows a floating "jump to latest" chevron when
  // the user is scrolled meaningfully above the bottom of the message list.
  // Doubles as a discoverability hint on iPhone PWA where the page sometimes
  // loads with the message list scrolled high and it isn't obvious the area
  // is scrollable — the bouncing chevron makes it obvious.
  const [showScrollHint, setShowScrollHint] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const compute = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      // 200px gives a comfortable threshold — incidental scroll on a long
      // list of messages near the bottom doesn't trigger the hint.
      setShowScrollHint(distanceFromBottom > 200);
    };
    compute();
    el.addEventListener("scroll", compute, { passive: true });
    // Recompute when window resizes (keyboard show/hide on iOS changes clientHeight).
    window.addEventListener("resize", compute);
    return () => {
      el.removeEventListener("scroll", compute);
      window.removeEventListener("resize", compute);
    };
  }, [channel.id, messages.length]);

  const scrollToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(() => { taRef.current?.focus(); }, [channel.id]);

  // Mention autocomplete: detect @… at cursor
  const handleDraftChange = (val: string) => {
    setDraft(val);
    const ta = taRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? val.length;
    const before = val.slice(0, cursor);
    const m = before.match(/(?:^|\s)@([a-zA-Z0-9_.-]*)$/);
    if (m) {
      setMentionMatch({ query: m[1].toLowerCase(), startIdx: cursor - m[1].length - 1 });
      setMentionSelectedIdx(0);
    } else {
      setMentionMatch(null);
    }
  };

  const mentionCandidates = useMemo(() => {
    if (!mentionMatch) return [];
    const q = mentionMatch.query;
    const specials = [
      { kind: "special" as const, key: "here", label: "@here", desc: "Notify online members" },
      { kind: "special" as const, key: "everyone", label: "@everyone", desc: "Notify all project members" },
    ].filter((s) => s.key.startsWith(q));
    const userMatches = orgMembers
      .filter((u) => {
        const first = u.name.split(/\s+/)[0].toLowerCase();
        const full = u.name.toLowerCase().replace(/\s+/g, "");
        return first.startsWith(q) || full.startsWith(q) || u.name.toLowerCase().includes(q);
      })
      .slice(0, 6)
      .map((u) => ({ kind: "user" as const, user: u }));
    return [...specials, ...userMatches];
  }, [mentionMatch, orgMembers]);

  const insertMention = (text: string) => {
    if (!mentionMatch) return;
    const ta = taRef.current;
    if (!ta) return;
    const before = draft.slice(0, mentionMatch.startIdx);
    const cursor = ta.selectionStart ?? draft.length;
    const after = draft.slice(cursor);
    const next = `${before}@${text} ${after}`;
    setDraft(next);
    setMentionMatch(null);
    setTimeout(() => {
      ta.focus();
      const newPos = before.length + text.length + 2;
      ta.setSelectionRange(newPos, newPos);
    }, 0);
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionMatch && mentionCandidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionSelectedIdx((i) => (i + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionSelectedIdx((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const c = mentionCandidates[mentionSelectedIdx];
        if (c.kind === "special") insertMention(c.key);
        else insertMention(c.user.name.split(/\s+/)[0].toLowerCase());
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionMatch(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleSlashJob = async (rest: string): Promise<boolean> => {
    // /job REF (or legacy /object REF)  -> link existing job
    const ref = rest.trim();
    if (!ref) {
      sendMutation.mutate({
        content: "_Usage: `/job REF` to link a job to this channel._",
      });
      return true;
    }
    try {
      await apiRequest("POST", `/api/channels/${channel.id}/work-objects`, { ref });
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channel.id, "work-objects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/work-objects"] });
      sendMutation.mutate({ content: `🔗 Linked job **${ref}** to this channel.` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      sendMutation.mutate({ content: `_Could not link ${ref}: ${msg}_` });
    }
    return true;
  };

  const submit = () => {
    const body = draft.trim();
    if ((!body && readyIds.length === 0) || sendMutation.isPending || uploading) return;

    // Slash command interception: /job is primary; /object kept as silent alias
    // for one release so existing muscle memory still works.
    const jobCmdMatch = /^\/(job|object)(?=\s|$)/.exec(body);
    if (jobCmdMatch) {
      const rest = body.slice(jobCmdMatch[0].length);
      setDraft("");
      clearPending();
      setMentionMatch(null);
      void handleSlashJob(rest);
      return;
    }

    sendMutation.mutate({
      content: body || " ",
      attachmentIds: readyIds.length > 0 ? readyIds : undefined,
    });
    setDraft("");
    clearPending();
    setMentionMatch(null);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  };

  // Paste-from-clipboard: when an image is pasted into the composer, treat it
  // as an attachment (common for screenshots / photos on desktop + mobile).
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length > 0) {
      e.preventDefault();
      addFiles(images);
    }
  };

  const pinned = messages.find((m) => m.isPinned);

  // Collapse consecutive runs of deleted (tombstoned) messages into a single
  // muted divider so a bulk-delete doesn't flood the view with N "Message
  // deleted" rows. Pure presentation: deletion semantics/API/DB untouched —
  // we only change how an already-deleted run is drawn. Mixed authors in a
  // run collapse together.
  const renderItems = useMemo(() => {
    type Item =
      | { type: "msg"; msg: ApiMessage; grouped: boolean }
      | { type: "deleted-run"; key: string; count: number };
    // First pass: for each scheduledCallId, figure out the latest status the
    // channel has emitted (`scheduled_call.created` → `started` → `cancelled`).
    // We render only the latest card per meeting so the channel doesn't grow
    // to N stacked variants of the SAME meeting (Teams-style consolidation).
    const latestCardMsgIdByCall = new Map<number, number>();
    for (const m of messages) {
      const meta = (m as { meta?: { kind?: string; scheduledCallId?: number } | null }).meta;
      if (!meta || typeof meta !== "object") continue;
      if (!String(meta.kind ?? "").startsWith("scheduled_call.")) continue;
      const id = meta.scheduledCallId;
      if (typeof id !== "number") continue;
      // Last write wins — messages are in chronological order, so the last
      // matching message we see for this scheduledCallId is the freshest.
      latestCardMsgIdByCall.set(id, m.id);
    }

    const items: Item[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.deletedAt) {
        let count = 0;
        const firstId = msg.id;
        while (i < messages.length && messages[i].deletedAt) {
          count++;
          i++;
        }
        i--; // for-loop will re-increment
        items.push({ type: "deleted-run", key: `del-${firstId}`, count });
        continue;
      }
      // Suppress older scheduled-call cards once a newer card for the SAME
      // meeting exists. Keeps the channel showing one current card per
      // meeting (Scheduled → Started → Cancelled) instead of a stack.
      const sMeta = (msg as { meta?: { kind?: string; scheduledCallId?: number } | null }).meta;
      if (
        sMeta &&
        typeof sMeta === "object" &&
        String(sMeta.kind ?? "").startsWith("scheduled_call.") &&
        typeof sMeta.scheduledCallId === "number"
      ) {
        const winner = latestCardMsgIdByCall.get(sMeta.scheduledCallId);
        if (winner !== undefined && winner !== msg.id) continue;
      }
      const prev = messages[i - 1];
      const grouped = !!(
        prev &&
        !prev.deletedAt &&
        prev.userId === msg.userId &&
        !msg.isPinned &&
        new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60 * 1000
      );
      items.push({ type: "msg", msg, grouped });
    }
    return items;
  }, [messages]);

  return (
    <section
      // min-h-0 is required so the inner `flex-1 overflow-y-auto` message
      // list can shrink and scroll instead of pushing the composer below
      // the viewport. Without it, flex children default to min-height:auto
      // which overflows the parent.
      className="flex-1 flex flex-col min-w-0 min-h-0 bg-background relative"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <header className="h-14 px-4 max-md:pl-14 flex items-center gap-3 border-b border-border shadow-sm shrink-0 bg-secondary/80 backdrop-blur-sm">
        <Hash className="w-5 h-5 text-[hsl(var(--vs-text-muted))]" />
        <div className="font-display text-[hsl(var(--vs-text))] text-base" data-testid="text-channel-name">{channel.name}</div>
        {channel.topic && (
          <>
            <span className="w-px h-5 bg-border" />
            <span className="text-xs text-[hsl(var(--vs-text-muted))] truncate hidden md:inline">{channel.topic}</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1 text-[hsl(var(--vs-text-muted))]">
          {/* Group-call quick actions — ring channel members from the
              text view without having to navigate to a voice channel. The
              phone icon starts an instant voice call; the camera icon opens
              a small menu so "Schedule meeting" is discoverable on mobile
              (where the slash command is hard to type). */}
          <button
            type="button"
            onClick={startHuddle}
            disabled={callBusy || huddleStarting}
            className="px-2.5 py-1.5 rounded hover-elevate text-[hsl(var(--vs-text-muted))] hover:text-[hsl(var(--vs-accent))] disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5 text-xs font-medium"
            title={callBusy ? "Already in a call" : "Start a huddle (drop-in voice + shareable link)"}
            data-testid="button-huddle"
          >
            {huddleStarting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Headphones className="w-4 h-4" />}
            <span className="hidden md:inline">Huddle</span>
          </button>
          <button
            type="button"
            onClick={() => setCallDialog("voice")}
            disabled={callBusy}
            className="p-2 rounded hover-elevate text-[hsl(var(--vs-text-muted))] hover:text-[hsl(var(--vs-accent))] disabled:opacity-40 disabled:cursor-not-allowed"
            title={callBusy ? "Already in a call" : "Start voice call"}
            data-testid="button-channel-call"
          >
            <Phone className="w-4 h-4" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="p-2 rounded hover-elevate text-[hsl(var(--vs-text-muted))] hover:text-[hsl(var(--vs-accent))] inline-flex items-center"
                title="Call & meeting options"
                data-testid="button-channel-video"
              >
                <Video className="w-4 h-4" />
                <ChevronDown className="w-3 h-3 -mr-0.5 opacity-70" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem
                disabled={callBusy}
                onSelect={() => setCallDialog("video")}
                data-testid="menu-start-video-call"
              >
                <Video className="w-4 h-4 mr-2" /> Start video call
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={callBusy}
                onSelect={() => setCallDialog("voice")}
                data-testid="menu-start-voice-call"
              >
                <Phone className="w-4 h-4 mr-2" /> Start voice call
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setCreateMeetingOpen(true)}
                data-testid="menu-new-meeting"
              >
                <Sparkles className="w-4 h-4 mr-2" /> New meeting (shareable link)…
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onSlashSchedule?.(`Meeting in #${channel.name}`)}
                data-testid="menu-schedule-meeting"
              >
                <CalendarIcon className="w-4 h-4 mr-2" /> Schedule meeting…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="w-px h-5 bg-border mx-1" />

          {/* Desktop (≥sm): pin / jobs / members shown inline. On mobile they
              collapse into the overflow menu below so the channel title has
              room and isn't truncated. */}
          <div className="hidden sm:flex items-center gap-1">
            <HeaderIcon
              title={pinned ? "Jump to pinned message" : "No pinned message"}
              onClick={pinned ? scrollToPinned : undefined}
              disabled={!pinned}
              data-testid="button-pinned"
            >
              <Pin className="w-4 h-4" />
            </HeaderIcon>
            <HeaderIcon
              title={workObjectsOpen ? "Hide jobs" : "Show jobs"}
              onClick={onToggleWorkObjects}
              active={!!workObjectsOpen}
              data-testid="button-work-objects-toggle"
            >
              <ClipboardList className="w-4 h-4" />
            </HeaderIcon>
            <HeaderIcon
              title={membersOpen ? "Hide members" : "Show members"}
              onClick={onToggleMembers}
              active={!!membersOpen}
              data-testid="button-members-toggle"
            >
              <Users className="w-4 h-4" />
            </HeaderIcon>
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="ml-1 flex items-center gap-2 bg-background border border-border text-xs text-[hsl(var(--vs-text-muted))] hover:text-[hsl(var(--vs-accent))] hover:border-[hsl(var(--vs-accent))] transition-colors rounded-md px-2 py-1"
              title="Search (⌘K)"
              data-testid="button-open-search"
            >
              <Search className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Search</span>
              <kbd className="hidden sm:inline font-mono text-[10px] text-[hsl(var(--vs-text-subtle))] border border-border rounded px-1">⌘K</kbd>
            </button>
            {me.role === "admin" && (
              <HeaderIcon
                title="Clear all messages (admin)"
                onClick={onClearChannel}
                disabled={clearChannelMut.isPending}
                data-testid="button-clear-channel"
              >
                <Trash2 className="w-4 h-4" />
              </HeaderIcon>
            )}
          </div>

          {/* Mobile (<sm): overflow menu holding pin / jobs / members / search. */}
          <div className="sm:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="p-2 rounded hover-elevate text-[hsl(var(--vs-text-muted))] hover:text-[hsl(var(--vs-accent))]"
                  title="More"
                  data-testid="button-header-overflow"
                >
                  <MoreHorizontal className="w-4 h-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  disabled={!pinned}
                  onSelect={() => pinned && scrollToPinned()}
                  data-testid="menu-pinned"
                >
                  <Pin className="w-4 h-4 mr-2" /> {pinned ? "Jump to pinned" : "No pinned message"}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onToggleWorkObjects?.()} data-testid="menu-work-objects">
                  <ClipboardList className="w-4 h-4 mr-2" /> {workObjectsOpen ? "Hide jobs" : "Show jobs"}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onToggleMembers?.()} data-testid="menu-members">
                  <Users className="w-4 h-4 mr-2" /> {membersOpen ? "Hide members" : "Show members"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setSearchOpen(true)} data-testid="menu-search">
                  <Search className="w-4 h-4 mr-2" /> Search
                </DropdownMenuItem>
                {me.role === "admin" && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={onClearChannel}
                      disabled={clearChannelMut.isPending}
                      data-testid="menu-clear-channel"
                      className="text-[hsl(var(--vs-accent))] focus:text-[hsl(var(--vs-accent-hover))]"
                    >
                      <Trash2 className="w-4 h-4 mr-2" /> Clear all messages
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {/* Phase 1.9.3 — contract banner. Renders above the pinned-message
          banner so the contract context is the first thing members see. */}
      {channel.linkedContract && (
        <ContractBanner channel={channel} contract={channel.linkedContract} me={me} />
      )}

      {pinned && (
        <div ref={pinnedBannerRef} className="px-4 py-2 bg-[hsl(var(--vs-accent)/0.08)] border-b border-[hsl(var(--vs-accent)/0.25)] flex items-start gap-2 text-xs transition-shadow rounded-sm">
          <Pin className="w-3.5 h-3.5 text-vs-red mt-0.5 shrink-0" />
          <div className="text-[hsl(var(--vs-text))] leading-snug">
            <span className="text-vs-red font-semibold">Pinned · {pinned.authorName}: </span>
            <span className="line-clamp-1">{pinned.content.replace(/\*\*/g, "").split("\n")[0]}</span>
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-0.5 vs-grain relative"
        data-testid="list-messages"
      >
        {dragOver && (
          <div className="absolute inset-0 z-10 bg-vs-red/10 border-2 border-dashed border-vs-red m-2 rounded-xl flex items-center justify-center pointer-events-none">
            <div className="text-vs-red font-display text-lg flex items-center gap-2">
              <Paperclip className="w-5 h-5" /> Drop files to attach
            </div>
          </div>
        )}
        <ChannelIntro channel={channel} />
        {loading && messages.length === 0 && (
          <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-vs-blue" /></div>
        )}
        {!loading && messages.length === 0 && (
          <div className="text-sm text-[hsl(var(--vs-text-muted))] py-6">No messages yet. Say hello.</div>
        )}
        <AnimatePresence initial={false}>
          {renderItems.map((item) =>
            item.type === "deleted-run" ? (
              <DeletedRunRow key={item.key} count={item.count} />
            ) : (
              <MessageRow
                key={item.msg.id}
                msg={item.msg}
                grouped={item.grouped}
                isMe={item.msg.userId === me.id}
                meId={me.id}
                myRole={me.role}
                onOpenThread={() => setThreadParent(item.msg)}
                onJoinMeeting={(kind) => setCallDialog(kind)}
                onOpenNotes={() => setNotesOpen(true)}
              />
            ),
          )}
        </AnimatePresence>
      </div>

      {/* Floating "jump to latest" chevron. Anchored absolutely just above
          the composer; visible when the user has scrolled meaningfully above
          the bottom of the message list. Also serves as a discoverability
          hint on iPhone where the message area sometimes loads scrolled
          high — the gentle bounce signals the area IS scrollable. */}
      {showScrollHint && (
        <button
          type="button"
          onClick={scrollToLatest}
          aria-label="Scroll to latest messages"
          data-testid="button-scroll-to-latest"
          className="absolute left-1/2 -translate-x-1/2 z-10 bg-secondary/90 backdrop-blur-sm border border-border rounded-full shadow-lg px-3 py-1.5 flex items-center gap-1.5 text-xs text-[hsl(var(--vs-text))] hover:bg-secondary transition-colors animate-bounce"
          // Sit just above the composer wrapper. The composer's own
          // paddingBottom honours the floating-tab-bar inset, so anchoring
          // to bottom:100% of the composer keeps this clear too.
          style={{ bottom: "calc(4.5rem + max(env(safe-area-inset-bottom), var(--bulldog-safe-bottom, 0px)))" }}
        >
          <ChevronDown className="w-3.5 h-3.5" />
          <span>Jump to latest</span>
        </button>
      )}

      {/* Composer. On iOS Safari/PWA the body has safe-area-inset-bottom
          padding, but mobile Safari's bottom toolbar can still overlap the
          composer when it shows/hides. We add an additional env-based bottom
          padding so the message box is never clipped by the home indicator
          or Safari chrome.

          On the iOS 18 native shell, the floating-pill tab bar's inset is
          NOT included in env(safe-area-inset-bottom); the native
          WebTabViewController forwards it via --bulldog-safe-bottom. We take
          the max so the composer always clears whichever is taller. */}
      <div
        className="px-4 pt-2 shrink-0"
        style={{
          paddingBottom:
            "max(1rem, env(safe-area-inset-bottom), var(--bulldog-safe-bottom, 0px))",
        }}
      >
        {pendingAtts.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2" data-testid="row-pending-attachments">
            {pendingAtts.map((a) => (
              <div key={a.localId} className="relative group bg-secondary border border-border rounded-lg px-2 py-1.5 flex items-center gap-2 max-w-[200px]">
                {a.previewUrl ? (
                  <img src={a.previewUrl} alt="" className="w-9 h-9 rounded object-cover" />
                ) : (
                  <div className="w-9 h-9 rounded bg-[hsl(var(--vs-accent)/0.2)] flex items-center justify-center text-vs-red text-[10px] font-mono">FILE</div>
                )}
                <div className="min-w-0">
                  <div className="text-xs text-[hsl(var(--vs-text))] truncate max-w-[120px]">{a.filename}</div>
                  {a.status === "uploading" ? (
                    <div className="mt-1 h-1.5 w-[120px] rounded-full bg-[hsl(var(--vs-accent)/0.2)] overflow-hidden" data-testid={`upload-progress-${a.localId}`}>
                      <div className="h-full bg-vs-blue transition-all" style={{ width: `${a.progress}%` }} />
                    </div>
                  ) : a.status === "error" ? (
                    <div className="text-[10px] text-vs-red truncate max-w-[120px]" title={a.error}>{a.error ?? "Failed"}</div>
                  ) : (
                    <div className="text-[10px] text-[hsl(var(--vs-text-muted))] font-mono">{(a.sizeBytes / 1024).toFixed(0)} KB</div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => removePending(a.localId)}
                  className="opacity-0 group-hover:opacity-100 absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-vs-red text-white flex items-center justify-center transition-opacity"
                  title="Remove"
                  data-testid={`remove-pending-${a.localId}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="relative">
          {/* Mention popover */}
          {mentionMatch && mentionCandidates.length > 0 && (
            <div className="absolute bottom-full left-0 mb-2 w-72 max-h-64 overflow-y-auto bg-secondary border border-border rounded-lg shadow-xl z-20" data-testid="popover-mention">
              <div className="px-3 py-2 border-b border-border text-[10px] uppercase tracking-wider font-mono text-[hsl(var(--vs-text-subtle))]">
                Mention {mentionMatch.query && `· "${mentionMatch.query}"`}
              </div>
              {mentionCandidates.map((c, i) => {
                const active = i === mentionSelectedIdx;
                return (
                  <button
                    key={c.kind === "user" ? `u${c.user.id}` : `s${c.key}`}
                    type="button"
                    className={`w-full text-left px-3 py-2 flex items-center gap-2 ${active ? "bg-accent" : "hover:bg-accent"}`}
                    onMouseEnter={() => setMentionSelectedIdx(i)}
                    onClick={() => c.kind === "special" ? insertMention(c.key) : insertMention(c.user.name.split(/\s+/)[0].toLowerCase())}
                  >
                    {c.kind === "user" ? (
                      <>
                        <Avatar member={{ name: c.user.name, hue: c.user.hue }} size={24} />
                        <div className="min-w-0">
                          <div className="text-sm text-[hsl(var(--vs-text))] truncate">{c.user.name}</div>
                          <div className="text-[10px] text-[hsl(var(--vs-text-muted))] font-mono">{ROLE_LABEL[c.user.role]}</div>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="w-6 h-6 rounded-full bg-[hsl(35_100%_60%/0.2)] border border-[hsl(35_100%_60%/0.4)] flex items-center justify-center text-[10px] font-mono text-[hsl(35_100%_70%)] font-bold">@</div>
                        <div className="min-w-0">
                          <div className="text-sm text-[hsl(var(--vs-text))] font-mono">{c.label}</div>
                          <div className="text-[10px] text-[hsl(var(--vs-text-muted))]">{c.desc}</div>
                        </div>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex items-end gap-2 bg-secondary border border-border rounded-xl px-3 py-2 focus-within:border-vs-red transition-colors">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-[hsl(var(--vs-text-muted))] hover:text-vs-red transition-colors p-1"
              title="Attach file"
              data-testid="button-attach"
              disabled={atCapacity}
            >
              <Plus className="w-5 h-5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACH_ACCEPT}
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
              data-testid="input-file"
            />
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => handleDraftChange(e.target.value)}
              onKeyDown={handleKey}
              onPaste={onPaste}
              placeholder={`Message #${channel.name}`}
              rows={1}
              className="flex-1 bg-transparent text-sm text-[hsl(var(--vs-text))] placeholder:text-[hsl(var(--vs-text-subtle))] resize-none outline-none max-h-32 py-1"
              data-testid="textarea-composer"
            />
            <div className="flex items-center gap-0.5 text-[hsl(var(--vs-text-muted))]">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="hover:text-vs-red transition-colors p-1"
                title="Files"
                data-testid="button-files-icon"
              >
                <Paperclip className="w-4 h-4" />
              </button>
              <button type="button" className="hover:text-vs-red transition-colors p-1" title="Emoji"><Smile className="w-4 h-4" /></button>
              <button
                type="button"
                onClick={submit}
                disabled={(!draft.trim() && readyIds.length === 0) || sendMutation.isPending || uploading}
                className="ml-1 w-8 h-8 rounded-md bg-vs-red text-white flex items-center justify-center hover:bg-[hsl(var(--vs-red-bright))] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Send (Enter)"
                data-testid="button-send"
              >
                {sendMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
        <div className="px-2 mt-1.5 text-[10px] text-[hsl(var(--vs-text-subtle))] flex items-center justify-between">
          <span>Press <kbd className="font-mono text-[hsl(var(--vs-text-muted))]">Enter</kbd> to send · <kbd className="font-mono text-[hsl(var(--vs-text-muted))]">⌘K</kbd> to search</span>
          <span>{channel.topic ? `Topic: ${channel.topic.slice(0, 60)}${channel.topic.length > 60 ? "…" : ""}` : ""}</span>
        </div>
      </div>

      <ThreadPanel
        parentMessage={threadParent}
        channelId={channel.id}
        me={me}
        onClose={() => setThreadParent(null)}
      />
      <SearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onJump={(_chId, _msgId) => { /* TODO scroll to message */ }}
        channelId={channel.id}
      />
      <ChannelCallDialog
        channel={channel}
        fallbackMembers={orgMembers}
        meId={me.id}
        open={!!callDialog}
        initialKind={callDialog || "voice"}
        onClose={() => setCallDialog(null)}
      />
      <CreateMeetingDialog
        channel={channel}
        meId={me.id}
        open={createMeetingOpen}
        onClose={() => setCreateMeetingOpen(false)}
      />
      <MeetingNotesHistory channelId={channel.id} open={notesOpen} onClose={() => setNotesOpen(false)} />
    </section>
  );
}

function HeaderIcon({
  title,
  children,
  onClick,
  active,
  disabled,
  "data-testid": dataTestId,
}: {
  title: string;
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  "data-testid"?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      data-testid={dataTestId}
      className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${
        active
          ? "bg-[hsl(var(--vs-accent-soft))] text-[hsl(var(--vs-accent))]"
          : "text-[hsl(var(--vs-text-muted))] hover:bg-[hsl(var(--vs-accent-soft))] hover:text-[hsl(var(--vs-accent))]"
      } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      {children}
    </button>
  );
}

// Collapsed divider for a run of consecutive deleted messages. Centered,
// muted, small — no avatar/timestamp. Singular copy when count === 1.
function DeletedRunRow({ count }: { count: number }) {
  return (
    <div
      className="flex items-center justify-center py-1 text-[hsl(var(--vs-text-subtle))] text-xs italic"
      data-testid="deleted-run"
    >
      <Trash2 className="w-3 h-3 mr-1.5 shrink-0" />
      {count === 1 ? "Message deleted" : `${count} messages deleted`}
    </div>
  );
}

function ChannelIntro({ channel }: { channel: ApiChannel }) {
  return (
    <div className="py-6 mb-2">
      <div className="w-14 h-14 rounded-2xl bg-accent border border-vs-red/30 flex items-center justify-center mb-3">
        <Hash className="w-7 h-7 text-vs-red" />
      </div>
      <h2 className="text-xl font-display text-[hsl(var(--vs-text))]">Welcome to #{channel.name}</h2>
      <p className="text-sm text-[hsl(var(--vs-text-muted))] mt-1 max-w-xl">
        {channel.topic ?? "This is the start of the channel."}
      </p>
      <div className="mt-3 h-px bg-border" />
    </div>
  );
}

function SystemMessageRow({ meta, content, createdAt, meId, myRole, onJoinMeeting, onOpenNotes }: { meta: ApiSystemMessageMeta; content: string; createdAt: string; meId: number; myRole: UserRole; onJoinMeeting?: (kind: "voice" | "video") => void; onOpenNotes?: () => void }) {
  // Scheduled-call cards get their own rich row with RSVP buttons + .ics link
  // instead of the compact work-object banner.
  if (meta.kind.startsWith("scheduled_call.")) {
    const smeta = meta as ApiScheduledCallSystemMessageMeta;
    // Scheduled meetings carry their own `joinUrl` (/m/<code>). Route the
    // Join button to that URL directly so the meeting flow ranges over the
    // explicit invitee list instead of the ad-hoc channel ring dialog, which
    // would otherwise read channel members and show "Ring everyone in
    // #channel (0 people)" for company-wide channels like #announcements.
    return <ScheduledCallCard meta={smeta} createdAt={createdAt} meId={meId} myRole={myRole} />;
  }
  // Meeting-summary cards: title + preview + "View full notes".
  if (meta.kind === "meeting_summary") {
    return <MeetingSummaryCard meta={meta as ApiMeetingSummarySystemMessageMeta} createdAt={createdAt} onOpenNotes={onOpenNotes} />;
  }
  // Below here, meta must be a work-object kind. Narrow the type so TS knows.
  const wo = meta as ApiWorkObjectSystemMessageMeta;
  // Map system-message kind → lucide icon. Falls back to the work-object kind
  // icon if the event itself doesn't have a strong shape.
  const KindIcon =
    wo.kind === "work_object.linked"          ? Link2 :
    wo.kind === "work_object.unlinked"        ? Unlink :
    wo.kind === "work_object.status_changed"  ? CheckCircle2 :
    wo.kind === "work_object.owner_changed"   ? UserCog :
    wo.kind === "work_object.title_changed"   ? PenLine :
    wo.kind === "work_object.closed"          ? Lock :
    wo.kind === "work_object.reopened"        ? Unlock :
    /* work_object.created */                     ClipboardList;

  const WoIcon =
    wo.woKind === "job_site"        ? MapPin :
    wo.woKind === "work_project"    ? ClipboardList :
    wo.woKind === "change_order"    ? FileText :
    /* safety_incident */               AlertTriangle;

  // Render content with **bold** markdown stripped to spans. Keep it light
  // — system messages are short and don't need full markdown.
  const segments = content.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      className="flex items-center justify-center gap-2 my-1 py-1 px-3 mx-12 border-l-2 border-border text-[11px] text-[hsl(var(--vs-text-subtle))] italic text-center"
      data-testid={`system-message-${wo.kind}`}
      title={fmtTime(createdAt)}
    >
      <KindIcon className="w-3 h-3 shrink-0 opacity-70" />
      <span className="inline-flex items-center gap-1 not-italic">
        <WoIcon className="w-2.5 h-2.5 opacity-50" />
      </span>
      <span className="truncate">
        {segments.map((seg, i) => {
          if (seg.startsWith("**") && seg.endsWith("**")) {
            return <span key={i} className="font-mono not-italic text-[hsl(var(--vs-text-muted))]">{seg.slice(2, -2)}</span>;
          }
          return <span key={i}>{seg}</span>;
        })}
      </span>
      <span className="text-[10px] opacity-60 not-italic shrink-0">· {fmtTime(createdAt).split("at ")[1] ?? ""}</span>
    </motion.div>
  );
}

// MeetingSummaryCard — in-channel card for meeting_summary system messages.
// Shows the AI clerk title, a short preview, attendee/duration meta, and a
// button that opens the full MeetingNotesHistory panel.
function MeetingSummaryCard({ meta, createdAt, onOpenNotes }: { meta: ApiMeetingSummarySystemMessageMeta; createdAt: string; onOpenNotes?: () => void }) {
  const mins = Math.round((meta.durationSeconds ?? 0) / 60);
  const durationLabel = mins >= 1 ? `${mins} min` : `${meta.durationSeconds ?? 0}s`;
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      className="my-2 mx-12 rounded-lg border border-[hsl(var(--vs-info)/0.3)] bg-[hsl(var(--vs-info)/0.08)] overflow-hidden"
      data-testid="system-message-meeting_summary"
      title={fmtTime(createdAt)}
    >
      <div className="px-3 py-2 flex items-center gap-2 border-b border-[hsl(var(--vs-info)/0.2)]">
        <FileText className="w-4 h-4 text-vs-blue-light shrink-0" />
        <span className="text-sm font-semibold text-[hsl(var(--vs-text))] truncate">{meta.title || "Meeting notes"}</span>
        <span className="ml-auto text-[10px] font-mono text-[hsl(var(--vs-text-muted))] whitespace-nowrap shrink-0">
          {durationLabel} · {meta.attendeeCount ?? 0} attendee{(meta.attendeeCount ?? 0) === 1 ? "" : "s"}
        </span>
      </div>
      {meta.summaryPreview && (
        <div className="px-3 py-2 text-xs text-[hsl(var(--vs-text-muted))] whitespace-pre-wrap line-clamp-4">
          {meta.summaryPreview}
        </div>
      )}
      <div className="px-3 py-2 border-t border-[hsl(var(--vs-info)/0.2)]">
        <button
          type="button"
          onClick={() => onOpenNotes?.()}
          className="px-2.5 py-1 rounded-md text-xs bg-secondary border border-border hover:border-vs-blue hover:text-vs-blue-light text-[hsl(var(--vs-text))] flex items-center gap-1.5"
          data-testid="button-view-full-notes"
        >
          <FileText className="w-3 h-3" /> View full notes
        </button>
      </div>
    </motion.div>
  );
}

function MessageRow({ msg, grouped, isMe, meId, myRole, onOpenThread, onJoinMeeting, onOpenNotes }: { msg: ApiMessage; grouped: boolean; isMe: boolean; meId: number; myRole: UserRole; onOpenThread: () => void; onJoinMeeting?: (kind: "voice" | "video") => void; onOpenNotes?: () => void }) {
  // System messages (work-object events) render as compact centered banners.
  if (msg.meta && msg.meta.system) {
    return <SystemMessageRow meta={msg.meta} content={msg.content} createdAt={msg.createdAt} meId={meId} myRole={myRole} onJoinMeeting={onJoinMeeting} onOpenNotes={onOpenNotes} />;
  }


  const roleClass = ROLE_COLOR[msg.authorRole] ?? "text-[hsl(var(--vs-text))]";
  const canDelete = isMe || myRole === "admin";

  // Author/admin delete. Confirms once via window.confirm to avoid an extra
  // modal component for what is otherwise a quick action. The server
  // tombstones (not hard delete), so SSE will re-render this row as the
  // tombstone variant above; we don't need to optimistically remove it.
  const deleteMut = useMutation({
    mutationFn: async () => {
      return await apiRequest("DELETE", `/api/messages/${msg.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels", msg.channelId, "messages"] });
    },
  });

  const onDelete = () => {
    if (deleteMut.isPending) return;
    if (!window.confirm("Delete this message? This can't be undone.")) return;
    deleteMut.mutate();
  };

  // Phase 1.9.36 — replaced the old 450ms long-press with an always-visible
  // "⋯" kebab on every message row. Long-press was undiscoverable on touch.
  // The kebab is rendered inline (top-right of the row) and toggles a small
  // action sheet anchored beneath it. Desktop hover bar is kept so power
  // users keep the muscle memory; the kebab is just an additional, always-
  // visible entry point.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("touchstart", onDocClick);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("touchstart", onDocClick);
    };
  }, [menuOpen]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      className={[
        "group relative flex gap-3 px-2 py-1 rounded -mx-2 hover:bg-accent/50",
        grouped ? "" : "mt-4",
      ].join(" ")}
      data-testid={`message-${msg.id}`}
    >
      <div className="w-10 shrink-0">
        {!grouped ? (
          <Avatar member={{ name: msg.authorName, hue: msg.authorHue, initials: msg.authorInitials }} size={40} />
        ) : (
          <span className="opacity-0 group-hover:opacity-60 text-[10px] font-mono text-[hsl(var(--vs-text-subtle))] mt-1.5 block text-right pr-1">
            {fmtTime(msg.createdAt).split("at ")[1] ?? ""}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className={`font-semibold text-sm ${roleClass}`}>{msg.authorName}</span>
            <RoleBadge role={msg.authorRole} />
            {isMe && <span className="text-[10px] font-mono text-vs-red uppercase tracking-wider">You</span>}
            <span className="text-[10px] text-[hsl(var(--vs-text-subtle))]">{fmtTime(msg.createdAt)}</span>
            {msg.editedAt && <span className="text-[10px] text-[hsl(var(--vs-text-subtle))] italic">(edited)</span>}
          </div>
        )}
        <MessageBody body={msg.content} mentions={msg.mentions} meId={meId} />
        {msg.attachmentsList && msg.attachmentsList.length > 0 && <MessageAttachments atts={msg.attachmentsList} />}
        {msg.reactions && msg.reactions.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {msg.reactions.map((r) => (
              <span
                key={r.emoji}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[11px] font-mono bg-accent border-border text-[hsl(var(--vs-text))]"
              >
                <span>{r.emoji}</span>
                <span>{r.count}</span>
              </span>
            ))}
          </div>
        )}
        {(msg.replyCount ?? 0) > 0 && (
          <button
            type="button"
            onClick={onOpenThread}
            className="mt-1.5 inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border bg-secondary hover:bg-accent hover:border-vs-red text-xs text-vs-blue-light font-semibold transition-colors"
            data-testid={`button-open-thread-${msg.id}`}
          >
            <MessageSquare className="w-3 h-3" />
            {msg.replyCount} {msg.replyCount === 1 ? "reply" : "replies"}
            {msg.lastReplyAt && <span className="font-normal text-[hsl(var(--vs-text-muted))]">· last {new Date(msg.lastReplyAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>}
          </button>
        )}
      </div>

      {/* Desktop hover action bar — quick access for mouse users. Hidden
          on touch (no hover state); touch users use the kebab below. */}
      <div
        className="transition-opacity absolute top-0 right-10 hidden md:flex items-center gap-1 -translate-y-2 bg-secondary border border-border rounded-md px-1 py-0.5 shadow-md opacity-0 group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onOpenThread}
          className="p-1 rounded hover:bg-accent text-[hsl(var(--vs-text-muted))] hover:text-vs-red"
          title="Reply in comms"
          data-testid={`button-reply-thread-${msg.id}`}
        >
          <Reply className="w-3.5 h-3.5" />
        </button>
        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            disabled={deleteMut.isPending}
            className="p-1 rounded hover:bg-accent text-[hsl(var(--vs-text-muted))] hover:text-vs-red disabled:opacity-40"
            title={isMe ? "Delete message" : "Delete message (admin)"}
            data-testid={`button-delete-message-${msg.id}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Phase 1.9.36 — always-visible kebab. Discoverable on mobile,
          unobtrusive on desktop (faint until hover). Opens an action sheet
          anchored to the row with Reply / Delete options. */}
      <div
        ref={menuRef}
        className="absolute top-1 right-2 z-10"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => setMenuOpen(v => !v)}
          className="p-1.5 rounded-md text-[hsl(var(--vs-text-subtle))] hover:text-[hsl(var(--vs-accent))] hover:bg-[hsl(var(--vs-accent-soft))] md:opacity-40 md:group-hover:opacity-100 transition-opacity"
          title="Message actions"
          aria-label="Message actions"
          data-testid={`button-message-menu-${msg.id}`}
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
        {menuOpen && (
          <div
            className="absolute top-full right-0 mt-1 min-w-[160px] rounded-md border border-border bg-secondary shadow-xl py-1"
            role="menu"
            data-testid={`menu-message-${msg.id}`}
          >
            <button
              type="button"
              onClick={() => { setMenuOpen(false); onOpenThread(); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[hsl(var(--vs-text))] hover:bg-[hsl(var(--vs-accent-soft))] hover:text-[hsl(var(--vs-accent))] text-left"
              data-testid={`menu-item-reply-${msg.id}`}
            >
              <Reply className="w-3.5 h-3.5" />
              Reply in thread
            </button>
            {canDelete && (
              <button
                type="button"
                onClick={() => { setMenuOpen(false); onDelete(); }}
                disabled={deleteMut.isPending}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[hsl(var(--vs-accent))] hover:bg-accent hover:text-[hsl(var(--vs-accent-hover))] text-left disabled:opacity-40"
                data-testid={`menu-item-delete-${msg.id}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete message
              </button>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function RoleBadge({ role }: { role: UserRole }) {
  const color = {
    admin:   "bg-[hsl(var(--vs-accent)/0.18)] text-[hsl(var(--vs-accent))] border-[hsl(var(--vs-accent)/0.4)]",
    manager: "bg-[hsl(var(--vs-info)/0.15)] text-vs-blue-light border-[hsl(var(--vs-info)/0.4)]",
    user:    "bg-[hsl(145_60%_48%/0.15)] text-vs-green border-[hsl(145_60%_48%/0.4)]",
  }[role];

  return (
    <span className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-sm border ${color}`}>
      {ROLE_LABEL[role]}
    </span>
  );
}

function MessageBody({ body, mentions, meId }: { body: string; mentions?: ApiMessage["mentions"]; meId: number }) {
  const lines = body.split("\n");
  const myMention = mentions?.some((m) => m.type === "user" && m.mentionedUserId === meId);
  const hasBroadcast = mentions?.some((m) => m.type === "here" || m.type === "everyone");

  return (
    <div className="text-[13.5px] text-[hsl(var(--vs-text))] leading-relaxed mt-0.5 whitespace-pre-wrap break-words">
      {(myMention || hasBroadcast) && (
        <div className={`-ml-2 pl-2 border-l-4 ${myMention ? "border-vs-red bg-[hsl(var(--vs-accent)/0.06)]" : "border-[hsl(35_100%_60%)] bg-[hsl(35_100%_60%/0.05)]"} -mr-2 pr-2 py-0.5 rounded-r-sm`}>
          {lines.map((line, i) => (
            <Line key={i} line={line} mentions={mentions} meId={meId} />
          ))}
        </div>
      )}
      {!(myMention || hasBroadcast) && lines.map((line, i) => (
        <Line key={i} line={line} mentions={mentions} meId={meId} />
      ))}
    </div>
  );
}

function Line({ line, mentions, meId }: { line: string; mentions?: ApiMessage["mentions"]; meId: number }) {
  if (line.startsWith("> ")) {
    return (
      <div className="border-l-2 border-vs-red pl-2 my-1 text-[hsl(var(--vs-text-muted))] italic">
        {renderInline(line.slice(2), mentions, meId)}
      </div>
    );
  }
  return <div>{renderInline(line, mentions, meId)}</div>;
}

function renderInline(text: string, mentions: ApiMessage["mentions"] | undefined, meId: number) {
  const parts = text.split(/(\*\*[^*]+\*\*|@[a-zA-Z0-9_.-]+|https?:\/\/[^\s]+)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return <strong key={i} className="font-bold text-[hsl(var(--vs-text))]">{p.slice(2, -2)}</strong>;
    }
    if (/^https?:\/\//.test(p)) {
      // Trailing punctuation shouldn't be swallowed into the href (e.g. a URL
      // that ends a sentence with a period or sits inside parentheses).
      const m = p.match(/^(https?:\/\/[^\s]*?)([.,)\]]*)$/);
      const href = m ? m[1] : p;
      const tail = m ? m[2] : "";
      return (
        <span key={i}>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[hsl(var(--vs-accent))] underline underline-offset-2 hover:text-[hsl(var(--vs-accent-hover))] break-all"
            data-testid="message-link"
          >
            {href}
          </a>
          {tail}
        </span>
      );
    }
    if (p.startsWith("@")) {
      const handle = p.slice(1).toLowerCase();
      const isBroadcast = handle === "here" || handle === "everyone";
      const isMe = mentions?.some((m) => m.type === "user" && m.mentionedUserId === meId && (handle === "here" ? false : true));
      // self-mention if any user mention matched my id (simplification: highlight @firstname-of-me red)
      // We can use the mentions array to be precise:
      const matchedMention = mentions?.find((m) => {
        if (m.type === "here" && handle === "here") return true;
        if (m.type === "everyone" && handle === "everyone") return true;
        return false;
      });
      const selfMention = !isBroadcast && mentions?.some((m) => m.type === "user" && m.mentionedUserId === meId);
      const className = selfMention
        ? "bg-[hsl(var(--vs-accent)/0.25)] text-[hsl(var(--vs-accent))] px-1 rounded font-semibold"
        : isBroadcast
        ? "bg-[hsl(35_100%_60%/0.22)] text-[hsl(35_100%_72%)] px-1 rounded font-semibold"
        : "bg-[hsl(var(--vs-info)/0.22)] text-vs-blue-light px-1 rounded font-semibold";
      return (
        <span key={i} className={className} data-testid={`mention-${handle}`}>
          {p}
        </span>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ScheduledCallCard — in-channel card for scheduled_call.* system messages.
// Shows title, when, organizer, kind badge, RSVP buttons, .ics download.
// Renders inside the message stream like a work-object banner but bigger.
// ─────────────────────────────────────────────────────────────────────────

interface ScheduledCallInviteeLive {
  id: number;
  name: string;
  response: "pending" | "yes" | "no" | "maybe";
}

function ScheduledCallCard({ meta, createdAt, meId, myRole }: { meta: ApiScheduledCallSystemMessageMeta; createdAt: string; meId: number; myRole: UserRole }) {
  // Join button always navigates to the meeting's canonical /m/<code> page,
  // which handles invitee gating, ringing the explicit invitee list, and
  // guest joins via SMS link — the same flow Twilio uses. Falls back to the
  // meeting code if joinUrl is somehow absent on an older message.
  const onJoin = () => {
    const url = (meta as any).joinUrl || (meta as any).meetingCode ? ((meta as any).joinUrl ?? `/m/${(meta as any).meetingCode}`) : null;
    if (url) window.location.href = url;
  };
  const { toast } = useToast();
  const canDelete = meta.organizerId === meId || myRole === "admin";
  const startDate = new Date(meta.startAt);
  const whenLabel = startDate.toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  const cancelled = meta.kind === "scheduled_call.cancelled";
  const started = meta.kind === "scheduled_call.started";

  const rsvpMut = useMutation({
    mutationFn: async (response: "yes" | "no" | "maybe") =>
      apiRequest("POST", `/api/scheduled-calls/${meta.scheduledCallId}/rsvp`, { response }),
    onSuccess: (_data, response) => {
      queryClient.invalidateQueries({ queryKey: ["/api/scheduled-calls"] });
      const label = response === "yes" ? "Yes" : response === "no" ? "No" : "Maybe";
      toast({ title: `RSVP ${label} recorded` });
    },
    onError: (err: any) => {
      toast({ title: "RSVP failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const deleteMut = useMutation({
    mutationFn: async () =>
      apiRequest("DELETE", `/api/scheduled-calls/${meta.scheduledCallId}`),
    onSuccess: () => {
      // The server emits message:delete over the socket which removes the
      // card from the stream; also drop the meetings list cache.
      queryClient.invalidateQueries({ queryKey: ["/api/scheduled-calls"] });
      toast({ title: "Meeting deleted" });
    },
    onError: (err: any) => {
      toast({ title: "Delete failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const onDelete = () => {
    if (!window.confirm("Delete this meeting? All invitees will be notified.")) return;
    deleteMut.mutate();
  };

  const inviteesQuery = useQuery<{ invitees: ScheduledCallInviteeLive[] }>({
    queryKey: ["/api/scheduled-calls", meta.scheduledCallId, "invitees"],
    queryFn: () => apiRequest("GET", `/api/scheduled-calls/${meta.scheduledCallId}/invitees`),
    refetchInterval: 15000,
    enabled: !cancelled,
  });

  const liveInvitees: ScheduledCallInviteeLive[] = inviteesQuery.data?.invitees ?? (meta as any).invitees ?? [];

  // When the meeting is live, poll the public meeting shape for the active
  // participant count so the card can show e.g. "Started · 3 in meeting".
  const liveMeetingCode = (meta as any).meetingCode as string | null | undefined;
  const liveMeetingQuery = useQuery<{ meeting?: { activeParticipantCount?: number } }>({
    queryKey: ["/api/meetings", liveMeetingCode, "live"],
    queryFn: () => apiRequest("GET", `/api/meetings/${liveMeetingCode}`),
    refetchInterval: 10000,
    enabled: !!liveMeetingCode && started && !cancelled,
  });
  const activeCount = liveMeetingQuery.data?.meeting?.activeParticipantCount ?? 0;

  const Icon = meta.callKind === "video" ? Video : Mic;
  const accent = meta.callKind === "video" ? "vs-blue-light" : "vs-green";

  const responseDot = (r: ScheduledCallInviteeLive["response"]) =>
    r === "yes" ? "bg-emerald-400" :
    r === "no"  ? "bg-red-400" :
    r === "maybe" ? "bg-amber-400" :
    "bg-white/40";

  // Tinted pill fill per RSVP response (matches ActionPill variants):
  // accepted→success, declined→danger, tentative→warning, pending→neutral.
  const inviteeChipClass = (r: ScheduledCallInviteeLive["response"]) =>
    r === "yes" ? "bg-emerald-500/15 text-emerald-300" :
    r === "no"  ? "bg-red-500/15 text-red-300" :
    r === "maybe" ? "bg-amber-500/15 text-amber-300" :
    "bg-[hsl(var(--vs-accent-soft))] text-[hsl(var(--vs-text-muted))]";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className={`mx-2 md:mx-12 my-2 border rounded-lg p-3 ${cancelled ? "opacity-60 border-border" : `border-${accent}/40 bg-${accent}/5`}`}
      data-testid={`scheduled-call-card-${meta.scheduledCallId}`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`w-10 h-10 rounded-full bg-${accent}/15 border border-${accent}/40 flex items-center justify-center shrink-0`}
        >
          <Icon className={`w-5 h-5 text-${accent}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-mono uppercase tracking-wider text-[hsl(var(--vs-text-subtle))]">
              {cancelled ? "Cancelled" : started ? "Started" : meta.kind === "scheduled_call.updated" ? "Updated" : "Scheduled"}
            </span>
            {started && !cancelled && activeCount > 0 && (
              <span
                className="text-[10px] font-mono uppercase tracking-wider text-emerald-300 flex items-center gap-1"
                data-testid={`scheduled-call-live-count-${meta.scheduledCallId}`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                {activeCount} in meeting
              </span>
            )}
            <CalendarIcon className="w-3 h-3 text-[hsl(var(--vs-text-subtle))]" />
            <span className="text-[11px] text-[hsl(var(--vs-text-muted))]">{whenLabel}</span>
            <div className="ml-auto flex items-center gap-1.5">
              {((meta as any).provider === "teams") ? (
                <>
                  {!cancelled && (meta as any).teamsJoinUrl && (
                    <a
                      href={(meta as any).teamsJoinUrl as string}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-1.5 rounded-md bg-[#5b5fc7] hover:bg-[#4a4ea8] text-[11px] font-bold flex items-center gap-1.5 text-white shadow-sm"
                      data-testid={`button-card-teams-${meta.scheduledCallId}`}
                      title="Join via Microsoft Teams"
                    >
                      <Video className="w-3 h-3" /> Teams
                    </a>
                  )}
                  {onJoin && !cancelled && (
                    <button
                      type="button"
                      onClick={() => onJoin?.()}
                      className="px-3 py-1.5 rounded-md bg-vs-green hover:bg-vs-green/85 text-[11px] font-bold flex items-center gap-1.5 text-white shadow-sm"
                      data-testid={`button-card-join-${meta.scheduledCallId}`}
                    >
                      <Icon className="w-3 h-3" /> Bulldog
                    </button>
                  )}
                </>
              ) : (
                <>
                  {onJoin && !cancelled && (
                    <button
                      type="button"
                      onClick={() => onJoin?.()}
                      className="px-3 py-1.5 rounded-md bg-vs-green hover:bg-vs-green/85 text-[11px] font-bold flex items-center gap-1.5 text-white shadow-sm"
                      data-testid={`button-card-join-${meta.scheduledCallId}`}
                    >
                      <Icon className="w-3 h-3" /> Join
                    </button>
                  )}
                  {!cancelled && (meta as any).teamsJoinUrl && (
                    <a
                      href={(meta as any).teamsJoinUrl as string}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-1.5 rounded-md bg-[#5b5fc7] hover:bg-[#4a4ea8] text-[11px] font-bold flex items-center gap-1.5 text-white shadow-sm"
                      data-testid={`button-card-teams-${meta.scheduledCallId}`}
                      title="Join via Microsoft Teams"
                    >
                      <Video className="w-3 h-3" /> Teams
                    </a>
                  )}
                </>
              )}
              {canDelete && !cancelled && (
                <ActionPill
                  variant="danger"
                  size="sm"
                  onClick={onDelete}
                  disabled={deleteMut.isPending}
                  icon={<Trash2 />}
                  title="Delete meeting"
                  data-testid={`button-card-delete-${meta.scheduledCallId}`}
                >
                  Delete
                </ActionPill>
              )}
            </div>
          </div>
          <div className="text-sm font-semibold text-[hsl(var(--vs-text))] mt-0.5">{meta.callTitle}</div>
          {!cancelled && (
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              <span className="text-[10px] uppercase tracking-wider text-[hsl(var(--vs-text-subtle))] font-mono">RSVP:</span>
              <ActionPill
                variant="success"
                onClick={() => rsvpMut.mutate("yes")}
                disabled={rsvpMut.isPending}
                icon={<Check />}
                data-testid={`button-card-rsvp-${meta.scheduledCallId}-yes`}
              >
                Yes
              </ActionPill>
              <ActionPill
                variant="danger"
                onClick={() => rsvpMut.mutate("no")}
                disabled={rsvpMut.isPending}
                icon={<Ban />}
                data-testid={`button-card-rsvp-${meta.scheduledCallId}-no`}
              >
                No
              </ActionPill>
              <ActionPill
                variant="warning"
                onClick={() => rsvpMut.mutate("maybe")}
                disabled={rsvpMut.isPending}
                icon={<HelpCircle />}
                data-testid={`button-card-rsvp-${meta.scheduledCallId}-maybe`}
              >
                Maybe
              </ActionPill>
              <ActionPill asChild variant="primary" className="ml-auto">
                <a
                  href={`/api/scheduled-calls/${meta.scheduledCallId}/ics`}
                  data-testid={`link-card-ics-${meta.scheduledCallId}`}
                >
                  <CalendarIcon /> .ics
                </a>
              </ActionPill>
            </div>
          )}
        </div>
      </div>
      {liveInvitees.length > 0 && (
        <div className="flex items-center flex-wrap gap-1.5 mt-2">
          {liveInvitees.map((inv) => (
            <span
              key={inv.id}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium border border-transparent ${inviteeChipClass(inv.response)}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full inline-block shrink-0 ${responseDot(inv.response)}`} />
              {inv.name}
            </span>
          ))}
        </div>
      )}
      <div className="text-[10px] text-[hsl(var(--vs-text-subtle))] mt-2 text-right font-mono uppercase tracking-wider">
        {fmtTime(createdAt)}
      </div>
    </motion.div>
  );
}
