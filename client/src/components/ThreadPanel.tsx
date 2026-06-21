import { useEffect, useRef, useState, KeyboardEvent } from "react";
import { X, Send, Loader2, MessageSquare } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Avatar } from "./Avatar";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ApiMessage, ApiUser } from "@/types/api";
import { MessageAttachments } from "./MessageAttachments";

interface Props {
  parentMessage: ApiMessage | null;
  channelId: number;
  me: ApiUser;
  onClose: () => void;
}

export function ThreadPanel({ parentMessage, channelId, me, onClose }: Props) {
  const [draft, setDraft] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const repliesQ = useQuery<ApiMessage[]>({
    queryKey: ["/api/messages", parentMessage?.id, "replies"],
    enabled: !!parentMessage,
  });

  const sendReply = useMutation({
    mutationFn: async (content: string) =>
      apiRequest<ApiMessage>("POST", `/api/channels/${channelId}/messages`, {
        content,
        replyToMessageId: parentMessage?.id,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/messages", parentMessage?.id, "replies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channelId, "messages"] });
    },
  });

  useEffect(() => {
    if (parentMessage) setTimeout(() => taRef.current?.focus(), 100);
  }, [parentMessage?.id]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [repliesQ.data?.length]);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const submit = () => {
    const body = draft.trim();
    if (!body || sendReply.isPending) return;
    sendReply.mutate(body);
    setDraft("");
  };

  const replies = repliesQ.data ?? [];

  return (
    <AnimatePresence>
      {parentMessage && (
        <motion.aside
          className="fixed top-0 right-0 bottom-0 w-full sm:w-[420px] z-40 bg-[hsl(220_55%_13%)] border-l border-[hsl(220_40%_22%)] flex flex-col shadow-2xl"
          initial={{ x: 480, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 480, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          data-testid="panel-thread"
        >
          <header className="h-14 px-4 flex items-center justify-between border-b border-[hsl(220_40%_22%)] shrink-0 bg-[hsl(220_60%_12%)]">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-vs-red" />
              <div>
                <div className="text-sm font-display text-white">Comms</div>
                <div className="text-[10px] text-[hsl(0_0%_55%)] font-mono">{replies.length} {replies.length === 1 ? "reply" : "replies"}</div>
              </div>
            </div>
            <button type="button" onClick={onClose} className="p-1 rounded hover:bg-[hsl(220_45%_22%)] text-[hsl(0_0%_70%)] hover:text-white" title="Close" data-testid="button-thread-close">
              <X className="w-5 h-5" />
            </button>
          </header>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3" data-testid="list-thread-messages">
            {/* Parent */}
            <ThreadMessage msg={parentMessage} isParent />
            <div className="flex items-center gap-2 my-2">
              <div className="flex-1 h-px bg-[hsl(220_40%_22%)]" />
              <span className="text-[10px] uppercase tracking-wider font-mono text-[hsl(0_0%_50%)]">
                {replies.length} {replies.length === 1 ? "reply" : "replies"}
              </span>
              <div className="flex-1 h-px bg-[hsl(220_40%_22%)]" />
            </div>
            {repliesQ.isLoading && (
              <div className="py-6 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-vs-blue" /></div>
            )}
            {replies.map((m) => (
              <ThreadMessage key={m.id} msg={m} />
            ))}
          </div>

          <div className="shrink-0 px-3 pb-3 pt-2 border-t border-[hsl(220_40%_22%)]">
            <div className="flex items-end gap-2 bg-[hsl(220_50%_16%)] border border-[hsl(220_40%_25%)] rounded-xl px-3 py-2 focus-within:border-vs-red transition-colors">
              <textarea
                ref={taRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Reply in comms…"
                rows={1}
                className="flex-1 bg-transparent text-sm text-white placeholder:text-[hsl(0_0%_50%)] resize-none outline-none max-h-24 py-1"
                data-testid="textarea-thread-composer"
              />
              <button
                type="button"
                onClick={submit}
                disabled={!draft.trim() || sendReply.isPending}
                className="w-8 h-8 rounded-md bg-vs-red text-white flex items-center justify-center hover:bg-[hsl(var(--vs-red-bright))] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Send (Enter)"
                data-testid="button-thread-send"
              >
                {sendReply.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function ThreadMessage({ msg, isParent = false }: { msg: ApiMessage; isParent?: boolean }) {
  return (
    <div className={`flex gap-2 ${isParent ? "pb-2 border-b border-[hsl(220_40%_22%)]" : ""}`}>
      <Avatar member={{ name: msg.authorName, hue: msg.authorHue, initials: msg.authorInitials }} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-white">{msg.authorName}</span>
          <span className="text-[10px] text-[hsl(0_0%_55%)]">{new Date(msg.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
        </div>
        <div className="text-[13px] text-[hsl(0_0%_88%)] leading-relaxed whitespace-pre-wrap break-words mt-0.5">{msg.content}</div>
        {msg.attachmentsList && msg.attachmentsList.length > 0 && <MessageAttachments atts={msg.attachmentsList} />}
      </div>
    </div>
  );
}
