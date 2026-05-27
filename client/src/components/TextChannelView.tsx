import { Hash, Pin, Plus, Smile, Paperclip, Send, Bell, Users, Search, AtSign, Inbox, HelpCircle, Bookmark, Loader2, MoreVertical } from "lucide-react";
import { Avatar } from "./Avatar";
import { useState, useRef, useEffect, KeyboardEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { ApiChannel, ApiMessage, ApiUser, UserRole } from "@/types/api";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface Props {
  channel: ApiChannel;
  messages: ApiMessage[];
  loading: boolean;
  me: ApiUser;
  orgMembers: ApiUser[];
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

export function TextChannelView({ channel, messages, loading, me, orgMembers }: Props) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const sendMutation = useMutation({
    mutationFn: async (content: string) =>
      apiRequest<ApiMessage>("POST", `/api/channels/${channel.id}/messages`, { content }),
    onSuccess: () => {
      // SSE will refresh, but if it's not connected we still want immediate UI
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channel.id, "messages"] });
    },
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, channel.id]);

  useEffect(() => { taRef.current?.focus(); }, [channel.id]);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const submit = () => {
    const body = draft.trim();
    if (!body || sendMutation.isPending) return;
    sendMutation.mutate(body);
    setDraft("");
  };

  const pinned = messages.find((m) => m.isPinned);

  return (
    <section className="flex-1 flex flex-col min-w-0 bg-background relative">
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
          <HeaderIcon title="Notifications"><Bell className="w-4 h-4" /></HeaderIcon>
          <HeaderIcon title="Pinned"><Pin className="w-4 h-4" /></HeaderIcon>
          <HeaderIcon title="Members"><Users className="w-4 h-4" /></HeaderIcon>
          <HeaderIcon title="Inbox"><Inbox className="w-4 h-4" /></HeaderIcon>
          <HeaderIcon title="Help"><HelpCircle className="w-4 h-4" /></HeaderIcon>
          <div className="ml-1 relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(0_0%_55%)]" />
            <input
              type="search"
              placeholder="Search"
              className="bg-[hsl(232_60%_9%)] border border-[hsl(232_40%_22%)] text-xs text-white placeholder:text-[hsl(0_0%_50%)] rounded-md pl-7 pr-2 py-1 w-32 focus:outline-none focus:ring-1 focus:ring-vs-red focus:w-48 transition-all"
              data-testid="input-search-messages"
            />
          </div>
        </div>
      </header>

      {pinned && (
        <div className="px-4 py-2 bg-[hsl(2_70%_55%/0.08)] border-b border-[hsl(2_70%_55%/0.25)] flex items-start gap-2 text-xs">
          <Pin className="w-3.5 h-3.5 text-vs-red mt-0.5 shrink-0" />
          <div className="text-[hsl(0_0%_82%)] leading-snug">
            <span className="text-vs-red font-semibold">Pinned · {pinned.authorName}: </span>
            <span className="line-clamp-1">{pinned.content.replace(/\*\*/g, "").split("\n")[0]}</span>
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-0.5 vs-grain"
        data-testid="list-messages"
      >
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
              <MessageRow key={msg.id} msg={msg} grouped={!!grouped} isMe={msg.userId === me.id} />
            );
          })}
        </AnimatePresence>
      </div>

      <div className="px-4 pb-4 pt-2 shrink-0">
        <div className="flex items-end gap-2 bg-[hsl(232_50%_16%)] border border-[hsl(232_40%_25%)] rounded-xl px-3 py-2 focus-within:border-vs-red transition-colors">
          <button
            type="button"
            className="text-[hsl(0_0%_65%)] hover:text-vs-red transition-colors p-1"
            title="Attach (coming soon)"
            data-testid="button-attach"
          >
            <Plus className="w-5 h-5" />
          </button>
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKey}
            placeholder={`Message #${channel.name}`}
            rows={1}
            className="flex-1 bg-transparent text-sm text-white placeholder:text-[hsl(0_0%_50%)] resize-none outline-none max-h-32 py-1"
            data-testid="textarea-composer"
          />
          <div className="flex items-center gap-0.5 text-[hsl(0_0%_65%)]">
            <button type="button" className="hover:text-vs-red transition-colors p-1" title="Mention"><AtSign className="w-4 h-4" /></button>
            <button type="button" className="hover:text-vs-red transition-colors p-1" title="Bookmark"><Bookmark className="w-4 h-4" /></button>
            <button type="button" className="hover:text-vs-red transition-colors p-1" title="Files"><Paperclip className="w-4 h-4" /></button>
            <button type="button" className="hover:text-vs-red transition-colors p-1" title="Emoji"><Smile className="w-4 h-4" /></button>
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || sendMutation.isPending}
              className="ml-1 w-8 h-8 rounded-md bg-vs-red text-white flex items-center justify-center hover:bg-[hsl(2_75%_60%)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Send (Enter)"
              data-testid="button-send"
            >
              {sendMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div className="px-2 mt-1.5 text-[10px] text-[hsl(0_0%_50%)] flex items-center justify-between">
          <span>Press <kbd className="font-mono text-[hsl(0_0%_70%)]">Enter</kbd> to send · <kbd className="font-mono text-[hsl(0_0%_70%)]">Shift+Enter</kbd> for newline</span>
          <span>{channel.topic ? `Topic: ${channel.topic.slice(0, 60)}${channel.topic.length > 60 ? "…" : ""}` : ""}</span>
        </div>
      </div>
    </section>
  );
}

function HeaderIcon({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-[hsl(232_45%_30%)] hover:text-white transition-colors"
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

function MessageRow({ msg, grouped, isMe }: { msg: ApiMessage; grouped: boolean; isMe: boolean }) {
  const roleClass = ROLE_COLOR[msg.authorRole] ?? "text-white";

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
        <MessageBody body={msg.content} />
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

function MessageBody({ body }: { body: string }) {
  const lines = body.split("\n");
  return (
    <div className="text-[13.5px] text-[hsl(0_0%_88%)] leading-relaxed mt-0.5 whitespace-pre-wrap break-words">
      {lines.map((line, i) => {
        if (line.startsWith("> ")) {
          return (
            <div key={i} className="border-l-2 border-vs-red pl-2 my-1 text-[hsl(0_0%_75%)] italic">
              {renderInline(line.slice(2))}
            </div>
          );
        }
        return <div key={i}>{renderInline(line)}</div>;
      })}
    </div>
  );
}

function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|@\w+)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return <strong key={i} className="font-bold text-white">{p.slice(2, -2)}</strong>;
    }
    if (p.startsWith("@")) {
      return (
        <span key={i} className="bg-[hsl(218_100%_68%/0.2)] text-vs-blue-light px-1 rounded">
          {p}
        </span>
      );
    }
    return <span key={i}>{p}</span>;
  });
}
