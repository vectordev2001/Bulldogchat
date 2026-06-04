import { Hash, Pin, Plus, Smile, Paperclip, Send, Users, Search, Loader2, MessageSquare, X, Reply, Phone, Video, ClipboardList, MapPin, FileText, AlertTriangle, Link2, Unlink, Lock, Unlock, UserCog, PenLine, CheckCircle2, Trash2, Calendar as CalendarIcon, Mic, Ban, Check, HelpCircle } from "lucide-react";
import { ChannelCallDialog } from "@/components/ChannelCallDialog";
import { useCalls } from "@/lib/CallContext";
import { Avatar } from "./Avatar";
import { useState, useRef, useEffect, KeyboardEvent, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { ApiChannel, ApiMessage, ApiUser, UserRole, ApiAttachment, ApiSystemMessageMeta, ApiWorkObjectSystemMessageMeta, ApiScheduledCallSystemMessageMeta } from "@/types/api";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, apiUpload, queryClient } from "@/lib/queryClient";
import { ThreadPanel } from "./ThreadPanel";
import { SearchModal } from "./SearchModal";
import { AttachmentList } from "./AttachmentRenderer";
import { ContractBanner } from "./ContractBanner";

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
  admin: "text-[hsl(2_85%_72%)]",
  foreman: "text-vs-blue-light",
  office: "text-[hsl(35_100%_70%)]",
  field: "text-vs-green",
  safety: "text-[hsl(2_85%_72%)]",
};
const ROLE_LABEL: Record<UserRole, string> = {
  admin: "Admin", foreman: "Foreman", office: "Office", field: "Field Crew", safety: "Safety",
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
  const [pendingAtts, setPendingAtts] = useState<ApiAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [threadParent, setThreadParent] = useState<ApiMessage | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0);
  const [callDialog, setCallDialog] = useState<null | "voice" | "video">(null);
  const { active: activeCall, outgoing: outgoingCall } = useCalls();
  const callBusy = !!activeCall || !!outgoingCall;

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
    if ((!body && pendingAtts.length === 0) || sendMutation.isPending) return;

    // Slash command interception: /job is primary; /object kept as silent alias
    // for one release so existing muscle memory still works.
    const jobCmdMatch = /^\/(job|object)(?=\s|$)/.exec(body);
    if (jobCmdMatch) {
      const rest = body.slice(jobCmdMatch[0].length);
      setDraft("");
      setPendingAtts([]);
      setMentionMatch(null);
      void handleSlashJob(rest);
      return;
    }

    sendMutation.mutate({
      content: body || " ",
      attachmentIds: pendingAtts.length > 0 ? pendingAtts.map((a) => a.id) : undefined,
    });
    setDraft("");
    setPendingAtts([]);
    setMentionMatch(null);
  };

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    try {
      const fd = new FormData();
      list.slice(0, 4).forEach((f) => fd.append("files", f));
      const res = await apiUpload<ApiAttachment[]>(`/api/uploads`, fd);
      setPendingAtts((p) => [...p, ...res].slice(0, 4));
    } catch (e: any) {
      alert(`Upload failed: ${e?.message ?? "Unknown"}`);
    } finally {
      setUploading(false);
    }
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
  };

  const pinned = messages.find((m) => m.isPinned);

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
      <header className="h-14 px-4 max-md:pl-14 flex items-center gap-3 border-b border-[hsl(232_40%_22%)] shadow-sm shrink-0 bg-[hsl(232_60%_12%)]/60 backdrop-blur-sm">
        <Hash className="w-5 h-5 text-[hsl(0_0%_55%)]" />
        <div className="font-display text-white text-base" data-testid="text-channel-name">{channel.name}</div>
        {channel.topic && (
          <>
            <span className="w-px h-5 bg-[hsl(232_40%_22%)]" />
            <span className="text-xs text-[hsl(0_0%_70%)] truncate hidden md:inline">{channel.topic}</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1 text-[hsl(0_0%_65%)]">
          {/* Group-call quick actions — ring channel members from the
              text view without having to navigate to a voice channel. */}
          <button
            type="button"
            onClick={() => setCallDialog("voice")}
            disabled={callBusy}
            className="p-2 rounded hover-elevate text-[hsl(0_0%_70%)] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            title={callBusy ? "Already in a call" : "Start voice call"}
            data-testid="button-channel-call"
          >
            <Phone className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setCallDialog("video")}
            disabled={callBusy}
            className="p-2 rounded hover-elevate text-[hsl(0_0%_70%)] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            title={callBusy ? "Already in a call" : "Start video call"}
            data-testid="button-channel-video"
          >
            <Video className="w-4 h-4" />
          </button>
          <span className="w-px h-5 bg-[hsl(232_40%_22%)] mx-1" />
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
            className="ml-1 flex items-center gap-2 bg-[hsl(232_60%_9%)] border border-[hsl(232_40%_22%)] text-xs text-[hsl(0_0%_65%)] hover:text-white hover:border-vs-red transition-colors rounded-md px-2 py-1"
            title="Search (⌘K)"
            data-testid="button-open-search"
          >
            <Search className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Search</span>
            <kbd className="hidden sm:inline font-mono text-[10px] text-[hsl(0_0%_55%)] border border-[hsl(232_40%_22%)] rounded px-1">⌘K</kbd>
          </button>
        </div>
      </header>

      {/* Phase 1.9.3 — contract banner. Renders above the pinned-message
          banner so the contract context is the first thing members see. */}
      {channel.linkedContract && (
        <ContractBanner channel={channel} contract={channel.linkedContract} me={me} />
      )}

      {pinned && (
        <div ref={pinnedBannerRef} className="px-4 py-2 bg-[hsl(2_70%_55%/0.08)] border-b border-[hsl(2_70%_55%/0.25)] flex items-start gap-2 text-xs transition-shadow rounded-sm">
          <Pin className="w-3.5 h-3.5 text-vs-red mt-0.5 shrink-0" />
          <div className="text-[hsl(0_0%_82%)] leading-snug">
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
          <div className="text-sm text-[hsl(0_0%_60%)] py-6">No messages yet. Say hello.</div>
        )}
        <AnimatePresence initial={false}>
          {messages.map((msg, i) => {
            const prev = messages[i - 1];
            const grouped =
              prev &&
              prev.userId === msg.userId &&
              !msg.isPinned &&
              new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60 * 1000;
            return (
              <MessageRow
                key={msg.id}
                msg={msg}
                grouped={!!grouped}
                isMe={msg.userId === me.id}
                meId={me.id}
                myRole={me.role}
                onOpenThread={() => setThreadParent(msg)}
                onJoinMeeting={(kind) => setCallDialog(kind)}
              />
            );
          })}
        </AnimatePresence>
      </div>

      {/* Composer. On iOS Safari/PWA the body has safe-area-inset-bottom
          padding, but mobile Safari's bottom toolbar can still overlap the
          composer when it shows/hides. We add an additional env-based bottom
          padding so the message box is never clipped by the home indicator
          or Safari chrome. */}
      <div
        className="px-4 pt-2 shrink-0"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        {pendingAtts.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2" data-testid="row-pending-attachments">
            {pendingAtts.map((a) => (
              <div key={a.id} className="relative group bg-[hsl(232_50%_16%)] border border-[hsl(232_40%_25%)] rounded-lg px-2 py-1.5 flex items-center gap-2 max-w-[200px]">
                {a.thumbnailUrl ? (
                  <img src={a.thumbnailUrl} alt="" className="w-9 h-9 rounded object-cover" />
                ) : (
                  <div className="w-9 h-9 rounded bg-[hsl(2_70%_55%/0.2)] flex items-center justify-center text-vs-red text-[10px] font-mono">FILE</div>
                )}
                <div className="min-w-0">
                  <div className="text-xs text-white truncate max-w-[120px]">{a.filename}</div>
                  <div className="text-[10px] text-[hsl(0_0%_60%)] font-mono">{(a.sizeBytes / 1024).toFixed(0)} KB</div>
                </div>
                <button
                  type="button"
                  onClick={() => setPendingAtts((p) => p.filter((x) => x.id !== a.id))}
                  className="opacity-0 group-hover:opacity-100 absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-vs-red text-white flex items-center justify-center transition-opacity"
                  title="Remove"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            {uploading && (
              <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-vs-blue">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Uploading…
              </div>
            )}
          </div>
        )}
        <div className="relative">
          {/* Mention popover */}
          {mentionMatch && mentionCandidates.length > 0 && (
            <div className="absolute bottom-full left-0 mb-2 w-72 max-h-64 overflow-y-auto bg-[hsl(232_55%_14%)] border border-[hsl(232_40%_25%)] rounded-lg shadow-xl z-20" data-testid="popover-mention">
              <div className="px-3 py-2 border-b border-[hsl(232_40%_22%)] text-[10px] uppercase tracking-wider font-mono text-[hsl(0_0%_55%)]">
                Mention {mentionMatch.query && `· "${mentionMatch.query}"`}
              </div>
              {mentionCandidates.map((c, i) => {
                const active = i === mentionSelectedIdx;
                return (
                  <button
                    key={c.kind === "user" ? `u${c.user.id}` : `s${c.key}`}
                    type="button"
                    className={`w-full text-left px-3 py-2 flex items-center gap-2 ${active ? "bg-[hsl(232_45%_22%)]" : "hover:bg-[hsl(232_45%_18%)]"}`}
                    onMouseEnter={() => setMentionSelectedIdx(i)}
                    onClick={() => c.kind === "special" ? insertMention(c.key) : insertMention(c.user.name.split(/\s+/)[0].toLowerCase())}
                  >
                    {c.kind === "user" ? (
                      <>
                        <Avatar member={{ name: c.user.name, hue: c.user.hue }} size={24} />
                        <div className="min-w-0">
                          <div className="text-sm text-white truncate">{c.user.name}</div>
                          <div className="text-[10px] text-[hsl(0_0%_60%)] font-mono">{ROLE_LABEL[c.user.role]}</div>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="w-6 h-6 rounded-full bg-[hsl(35_100%_60%/0.2)] border border-[hsl(35_100%_60%/0.4)] flex items-center justify-center text-[10px] font-mono text-[hsl(35_100%_70%)] font-bold">@</div>
                        <div className="min-w-0">
                          <div className="text-sm text-white font-mono">{c.label}</div>
                          <div className="text-[10px] text-[hsl(0_0%_60%)]">{c.desc}</div>
                        </div>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex items-end gap-2 bg-[hsl(232_50%_16%)] border border-[hsl(232_40%_25%)] rounded-xl px-3 py-2 focus-within:border-vs-red transition-colors">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-[hsl(0_0%_65%)] hover:text-vs-red transition-colors p-1"
              title="Attach file"
              data-testid="button-attach"
              disabled={uploading || pendingAtts.length >= 4}
            >
              <Plus className="w-5 h-5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) uploadFiles(e.target.files);
                e.target.value = "";
              }}
              data-testid="input-file"
            />
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => handleDraftChange(e.target.value)}
              onKeyDown={handleKey}
              placeholder={`Message #${channel.name}`}
              rows={1}
              className="flex-1 bg-transparent text-sm text-white placeholder:text-[hsl(0_0%_50%)] resize-none outline-none max-h-32 py-1"
              data-testid="textarea-composer"
            />
            <div className="flex items-center gap-0.5 text-[hsl(0_0%_65%)]">
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
                disabled={(!draft.trim() && pendingAtts.length === 0) || sendMutation.isPending}
                className="ml-1 w-8 h-8 rounded-md bg-vs-red text-white flex items-center justify-center hover:bg-[hsl(2_75%_60%)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Send (Enter)"
                data-testid="button-send"
              >
                {sendMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
        <div className="px-2 mt-1.5 text-[10px] text-[hsl(0_0%_50%)] flex items-center justify-between">
          <span>Press <kbd className="font-mono text-[hsl(0_0%_70%)]">Enter</kbd> to send · <kbd className="font-mono text-[hsl(0_0%_70%)]">⌘K</kbd> to search</span>
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
          ? "bg-[hsl(232_45%_30%)] text-white"
          : "hover:bg-[hsl(232_45%_30%)] hover:text-white"
      } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      {children}
    </button>
  );
}

function ChannelIntro({ channel }: { channel: ApiChannel }) {
  return (
    <div className="py-6 mb-2">
      <div className="w-14 h-14 rounded-2xl bg-[hsl(232_45%_27%)] border border-vs-red/30 flex items-center justify-center mb-3">
        <Hash className="w-7 h-7 text-vs-red" />
      </div>
      <h2 className="text-xl font-display text-white">Welcome to #{channel.name}</h2>
      <p className="text-sm text-[hsl(0_0%_70%)] mt-1 max-w-xl">
        {channel.topic ?? "This is the start of the channel."}
      </p>
      <div className="mt-3 h-px bg-[hsl(232_40%_22%)]" />
    </div>
  );
}

function SystemMessageRow({ meta, content, createdAt, onJoinMeeting }: { meta: ApiSystemMessageMeta; content: string; createdAt: string; onJoinMeeting?: (kind: "voice" | "video") => void }) {
  // Scheduled-call cards get their own rich row with RSVP buttons + .ics link
  // instead of the compact work-object banner.
  if (meta.kind.startsWith("scheduled_call.")) {
    const smeta = meta as ApiScheduledCallSystemMessageMeta;
    return <ScheduledCallCard meta={smeta} createdAt={createdAt} onJoin={onJoinMeeting ? () => onJoinMeeting(smeta.callKind) : undefined} />;
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
      className="flex items-center justify-center gap-2 my-1 py-1 px-3 mx-12 border-l-2 border-[hsl(232_40%_22%)] text-[11px] text-[hsl(0_0%_55%)] italic text-center"
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
            return <span key={i} className="font-mono not-italic text-[hsl(0_0%_75%)]">{seg.slice(2, -2)}</span>;
          }
          return <span key={i}>{seg}</span>;
        })}
      </span>
      <span className="text-[10px] opacity-60 not-italic shrink-0">· {fmtTime(createdAt).split("at ")[1] ?? ""}</span>
    </motion.div>
  );
}

function MessageRow({ msg, grouped, isMe, meId, myRole, onOpenThread, onJoinMeeting }: { msg: ApiMessage; grouped: boolean; isMe: boolean; meId: number; myRole: UserRole; onOpenThread: () => void; onJoinMeeting?: (kind: "voice" | "video") => void }) {
  // System messages (work-object events) render as compact centered banners.
  if (msg.meta && msg.meta.system) {
    return <SystemMessageRow meta={msg.meta} content={msg.content} createdAt={msg.createdAt} onJoinMeeting={onJoinMeeting} />;
  }

  // Tombstoned message — author or admin deleted it. We still render the
  // row so reply threading stays visually coherent, but content/avatar/
  // reactions are stripped down to a muted placeholder. Hover/long-press
  // actions are disabled here — nothing left to act on.
  if (msg.deletedAt) {
    return (
      <div
        className={[
          "flex gap-3 px-2 py-1 rounded -mx-2",
          grouped ? "" : "mt-4",
        ].join(" ")}
        data-testid={`message-${msg.id}-tombstone`}
      >
        <div className="w-10 shrink-0" />
        <div className="min-w-0 flex-1 text-[12.5px] italic text-[hsl(0_0%_50%)] flex items-center gap-1.5">
          <Trash2 className="w-3 h-3" />
          Message deleted
        </div>
      </div>
    );
  }

  const roleClass = ROLE_COLOR[msg.authorRole] ?? "text-white";
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

  // Long-press on mobile (no hover) surfaces the action bar. We use a
  // 450ms touch hold; tap-cancel clears the timer so taps don't accidentally
  // trigger the action bar.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const onTouchStart = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => setMobileActionsOpen(true), 450);
  };
  const onTouchEnd = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      className={[
        "group relative flex gap-3 px-2 py-1 rounded -mx-2 hover:bg-[hsl(232_45%_18%/0.5)]",
        grouped ? "" : "mt-4",
      ].join(" ")}
      data-testid={`message-${msg.id}`}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div className="w-10 shrink-0">
        {!grouped ? (
          <Avatar member={{ name: msg.authorName, hue: msg.authorHue, initials: msg.authorInitials }} size={40} />
        ) : (
          <span className="opacity-0 group-hover:opacity-60 text-[10px] font-mono text-[hsl(0_0%_55%)] mt-1.5 block text-right pr-1">
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
            <span className="text-[10px] text-[hsl(0_0%_55%)]">{fmtTime(msg.createdAt)}</span>
            {msg.editedAt && <span className="text-[10px] text-[hsl(0_0%_45%)] italic">(edited)</span>}
          </div>
        )}
        <MessageBody body={msg.content} mentions={msg.mentions} meId={meId} />
        {msg.attachmentsList && msg.attachmentsList.length > 0 && <AttachmentList atts={msg.attachmentsList} />}
        {msg.reactions && msg.reactions.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {msg.reactions.map((r) => (
              <span
                key={r.emoji}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[11px] font-mono bg-[hsl(232_45%_27%)] border-[hsl(232_40%_25%)] text-[hsl(0_0%_82%)]"
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
            className="mt-1.5 inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-[hsl(232_40%_25%)] bg-[hsl(232_50%_16%)] hover:bg-[hsl(232_45%_22%)] hover:border-vs-red text-xs text-vs-blue-light font-semibold transition-colors"
            data-testid={`button-open-thread-${msg.id}`}
          >
            <MessageSquare className="w-3 h-3" />
            {msg.replyCount} {msg.replyCount === 1 ? "reply" : "replies"}
            {msg.lastReplyAt && <span className="font-normal text-[hsl(0_0%_60%)]">· last {new Date(msg.lastReplyAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>}
          </button>
        )}
      </div>

      {/* Hover action bar (desktop): reply + delete (when permitted).
          On mobile, long-press toggles mobileActionsOpen which forces this
          panel visible (opacity-100 via the data attr). */}
      <div
        className={`transition-opacity absolute top-0 right-2 flex items-center gap-1 -translate-y-2 bg-[hsl(232_55%_14%)] border border-[hsl(232_40%_25%)] rounded-md px-1 py-0.5 shadow-md ${
          mobileActionsOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => { setMobileActionsOpen(false); onOpenThread(); }}
          className="p-1 rounded hover:bg-[hsl(232_45%_22%)] text-[hsl(0_0%_70%)] hover:text-vs-red"
          title="Reply in comms"
          data-testid={`button-reply-thread-${msg.id}`}
        >
          <Reply className="w-3.5 h-3.5" />
        </button>
        {canDelete && (
          <button
            type="button"
            onClick={() => { setMobileActionsOpen(false); onDelete(); }}
            disabled={deleteMut.isPending}
            className="p-1 rounded hover:bg-[hsl(232_45%_22%)] text-[hsl(0_0%_70%)] hover:text-vs-red disabled:opacity-40"
            title={isMe ? "Delete message" : "Delete message (admin)"}
            data-testid={`button-delete-message-${msg.id}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
        {mobileActionsOpen && (
          <button
            type="button"
            onClick={() => setMobileActionsOpen(false)}
            className="p-1 rounded hover:bg-[hsl(232_45%_22%)] text-[hsl(0_0%_70%)] hover:text-white"
            title="Close"
            data-testid={`button-close-mobile-actions-${msg.id}`}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </motion.div>
  );
}

function RoleBadge({ role }: { role: UserRole }) {
  const color = {
    admin:   "bg-[hsl(2_70%_55%/0.18)] text-[hsl(2_85%_72%)] border-[hsl(2_70%_55%/0.4)]",
    foreman: "bg-[hsl(218_100%_68%/0.15)] text-vs-blue-light border-[hsl(218_100%_68%/0.4)]",
    office:  "bg-[hsl(35_100%_60%/0.15)] text-[hsl(35_100%_72%)] border-[hsl(35_100%_60%/0.4)]",
    field:   "bg-[hsl(145_60%_48%/0.15)] text-vs-green border-[hsl(145_60%_48%/0.4)]",
    safety:  "bg-[hsl(2_70%_55%/0.15)] text-[hsl(2_85%_72%)] border-[hsl(2_70%_55%/0.4)]",
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
    <div className="text-[13.5px] text-[hsl(0_0%_88%)] leading-relaxed mt-0.5 whitespace-pre-wrap break-words">
      {(myMention || hasBroadcast) && (
        <div className={`-ml-2 pl-2 border-l-4 ${myMention ? "border-vs-red bg-[hsl(2_70%_55%/0.06)]" : "border-[hsl(35_100%_60%)] bg-[hsl(35_100%_60%/0.05)]"} -mr-2 pr-2 py-0.5 rounded-r-sm`}>
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
      <div className="border-l-2 border-vs-red pl-2 my-1 text-[hsl(0_0%_75%)] italic">
        {renderInline(line.slice(2), mentions, meId)}
      </div>
    );
  }
  return <div>{renderInline(line, mentions, meId)}</div>;
}

function renderInline(text: string, mentions: ApiMessage["mentions"] | undefined, meId: number) {
  const parts = text.split(/(\*\*[^*]+\*\*|@[a-zA-Z0-9_.-]+)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return <strong key={i} className="font-bold text-white">{p.slice(2, -2)}</strong>;
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
        ? "bg-[hsl(2_70%_55%/0.25)] text-[hsl(2_85%_72%)] px-1 rounded font-semibold"
        : isBroadcast
        ? "bg-[hsl(35_100%_60%/0.22)] text-[hsl(35_100%_72%)] px-1 rounded font-semibold"
        : "bg-[hsl(218_100%_68%/0.22)] text-vs-blue-light px-1 rounded font-semibold";
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

function ScheduledCallCard({ meta, createdAt, onJoin }: { meta: ApiScheduledCallSystemMessageMeta; createdAt: string; onJoin?: () => void }) {
  const { toast } = useToast();
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

  const inviteesQuery = useQuery<{ invitees: ScheduledCallInviteeLive[] }>({
    queryKey: ["/api/scheduled-calls", meta.scheduledCallId, "invitees"],
    queryFn: () => apiRequest("GET", `/api/scheduled-calls/${meta.scheduledCallId}/invitees`),
    refetchInterval: 15000,
    enabled: !cancelled,
  });

  const liveInvitees: ScheduledCallInviteeLive[] = inviteesQuery.data?.invitees ?? (meta as any).invitees ?? [];

  const Icon = meta.callKind === "video" ? Video : Mic;
  const accent = meta.callKind === "video" ? "vs-blue-light" : "vs-green";

  const responseDot = (r: ScheduledCallInviteeLive["response"]) =>
    r === "yes" ? "bg-vs-green" :
    r === "no"  ? "bg-vs-red" :
    r === "maybe" ? "bg-yellow-400" :
    "bg-[hsl(218_100%_68%/0.4)]";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className={`mx-2 md:mx-12 my-2 border rounded-lg p-3 ${cancelled ? "opacity-60 border-[hsl(232_40%_22%)]" : `border-${accent}/40 bg-${accent}/5`}`}
      data-testid={`scheduled-call-card-${meta.scheduledCallId}`}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          title="Join meeting"
          onClick={() => onJoin?.()}
          className={`w-10 h-10 rounded-full bg-${accent}/15 border border-${accent}/40 flex items-center justify-center shrink-0 cursor-pointer hover:bg-${accent}/25 transition-colors`}
        >
          <Icon className={`w-5 h-5 text-${accent}`} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-mono uppercase tracking-wider text-[hsl(0_0%_55%)]">
              {cancelled ? "Cancelled" : started ? "Started" : meta.kind === "scheduled_call.updated" ? "Updated" : "Scheduled"}
            </span>
            <CalendarIcon className="w-3 h-3 text-[hsl(0_0%_55%)]" />
            <span className="text-[11px] text-[hsl(0_0%_75%)]">{whenLabel}</span>
          </div>
          <div className="text-sm font-semibold text-white mt-0.5">{meta.callTitle}</div>
          {!cancelled && (
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              <span className="text-[10px] uppercase tracking-wider text-[hsl(0_0%_55%)] font-mono">RSVP:</span>
              <button
                type="button"
                onClick={() => rsvpMut.mutate("yes")}
                disabled={rsvpMut.isPending}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider border border-vs-green/40 bg-vs-green/10 hover:bg-vs-green/20 text-white disabled:opacity-50"
                data-testid={`button-card-rsvp-${meta.scheduledCallId}-yes`}
              >
                <Check className="w-3 h-3" /> Yes
              </button>
              <button
                type="button"
                onClick={() => rsvpMut.mutate("no")}
                disabled={rsvpMut.isPending}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider border border-vs-red/40 bg-vs-red/10 hover:bg-vs-red/20 text-white disabled:opacity-50"
                data-testid={`button-card-rsvp-${meta.scheduledCallId}-no`}
              >
                <Ban className="w-3 h-3" /> No
              </button>
              <button
                type="button"
                onClick={() => rsvpMut.mutate("maybe")}
                disabled={rsvpMut.isPending}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider border border-vs-blue-light/40 bg-vs-blue-light/10 hover:bg-vs-blue-light/20 text-white disabled:opacity-50"
                data-testid={`button-card-rsvp-${meta.scheduledCallId}-maybe`}
              >
                <HelpCircle className="w-3 h-3" /> Maybe
              </button>
              <a
                href={`/api/scheduled-calls/${meta.scheduledCallId}/ics`}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider border border-[hsl(232_40%_25%)] bg-[hsl(232_50%_18%)] hover:bg-[hsl(232_50%_22%)] text-white ml-auto"
                data-testid={`link-card-ics-${meta.scheduledCallId}`}
              >
                <CalendarIcon className="w-3 h-3" /> .ics
              </a>
            </div>
          )}
        </div>
      </div>
      {liveInvitees.length > 0 && (
        <div className="flex items-center flex-wrap gap-1.5 mt-2">
          {liveInvitees.map((inv) => (
            <span
              key={inv.id}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-[hsl(0_0%_80%)] border border-[hsl(232_40%_25%)] bg-[hsl(232_50%_16%)]"
            >
              <span className={`w-1.5 h-1.5 rounded-full inline-block shrink-0 ${responseDot(inv.response)}`} />
              {inv.name}
            </span>
          ))}
        </div>
      )}
      <div className="text-[10px] text-[hsl(0_0%_45%)] mt-2 text-right font-mono uppercase tracking-wider">
        {fmtTime(createdAt)}
      </div>
    </motion.div>
  );
}
