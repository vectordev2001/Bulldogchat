import { useEffect, useRef, useState } from "react";
import { Search, X, Loader2, Hash } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";

interface SearchResult {
  id: number;
  channelId: number;
  channelName: string | null;
  projectId: number | null;
  projectName: string | null;
  userId: number;
  authorName: string;
  content: string;
  createdAt: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onJump: (channelId: number, messageId: number) => void;
  channelId?: number | null; // optional scope
}

export function SearchModal({ open, onClose, onJump, channelId }: Props) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQ("");
      setDebouncedQ("");
    }
  }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 220);
    return () => clearTimeout(t);
  }, [q]);

  const search = useQuery<{ results: SearchResult[] }>({
    queryKey: ["/api/search", debouncedQ, channelId ?? ""],
    queryFn: async () => {
      if (!debouncedQ) return { results: [] };
      const params = new URLSearchParams({ q: debouncedQ, limit: "30" });
      if (channelId) params.set("channel_id", String(channelId));
      const res = await fetch(`/api/search?${params}`, { credentials: "include" });
      if (!res.ok) return { results: [] };
      return res.json();
    },
    enabled: open && debouncedQ.length > 0,
    staleTime: 5000,
  });

  // Keyboard: Esc closes
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  const results = search.data?.results ?? [];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 bg-black/70 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          data-testid="modal-search"
        >
          <motion.div
            className="w-full max-w-2xl bg-[hsl(220_55%_14%)] border border-[hsl(220_40%_25%)] rounded-2xl shadow-2xl overflow-hidden"
            initial={{ y: -20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -10, opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 flex items-center gap-3 border-b border-[hsl(220_40%_22%)]">
              <Search className="w-5 h-5 text-vs-red shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={channelId ? "Search this channel…" : "Search all messages…"}
                className="flex-1 bg-transparent text-white text-base placeholder:text-[hsl(0_0%_50%)] outline-none"
                data-testid="input-search-modal"
              />
              {search.isFetching && <Loader2 className="w-4 h-4 animate-spin text-vs-blue" />}
              <button
                type="button"
                onClick={onClose}
                className="text-[hsl(0_0%_60%)] hover:text-white p-1 rounded"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto" data-testid="list-search-results">
              {!debouncedQ && (
                <div className="px-6 py-10 text-center text-sm text-[hsl(0_0%_55%)]">
                  Type to search messages. Use <kbd className="font-mono text-[hsl(0_0%_75%)] px-1.5 py-0.5 rounded bg-black/30">⌘K</kbd> from anywhere.
                </div>
              )}
              {debouncedQ && !search.isFetching && results.length === 0 && (
                <div className="px-6 py-10 text-center text-sm text-[hsl(0_0%_55%)]">
                  No matches for <span className="text-white font-mono">"{debouncedQ}"</span>
                </div>
              )}
              {results.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="w-full text-left px-4 py-3 hover:bg-[hsl(220_45%_22%)] transition-colors border-b border-[hsl(220_40%_22%)]/50 last:border-b-0"
                  onClick={() => {
                    onJump(r.channelId, r.id);
                    onClose();
                  }}
                  data-testid={`result-${r.id}`}
                >
                  <div className="flex items-center gap-2 text-xs text-[hsl(0_0%_65%)] mb-1">
                    <Hash className="w-3 h-3 text-vs-red" />
                    <span className="font-semibold text-white">{r.channelName ?? "?"}</span>
                    {r.projectName && (<><span className="text-[hsl(0_0%_40%)]">·</span><span>{r.projectName}</span></>)}
                    <span className="text-[hsl(0_0%_40%)]">·</span>
                    <span>{r.authorName}</span>
                    <span className="ml-auto font-mono text-[10px]">{new Date(r.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="text-sm text-[hsl(0_0%_85%)] line-clamp-2" dangerouslySetInnerHTML={{ __html: highlight(r.content, debouncedQ) }} />
                </button>
              ))}
            </div>

            <div className="px-4 py-2 border-t border-[hsl(220_40%_22%)] flex items-center justify-between text-[11px] text-[hsl(0_0%_55%)] bg-[hsl(220_60%_11%)]">
              <span><kbd className="font-mono text-[hsl(0_0%_75%)]">↵</kbd> jump · <kbd className="font-mono text-[hsl(0_0%_75%)]">Esc</kbd> close</span>
              <span className="text-vs-red">SQLite FTS5</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function highlight(text: string, q: string): string {
  if (!q) return escapeHtml(text);
  const tokens = q.split(/\s+/).filter((t) => t.length > 0);
  let out = escapeHtml(text);
  for (const t of tokens) {
    const re = new RegExp(`(${escapeRegex(t)})`, "gi");
    out = out.replace(re, `<mark class="bg-[hsl(35_100%_60%/0.3)] text-white px-0.5 rounded">$1</mark>`);
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
