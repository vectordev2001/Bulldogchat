// BogeyBubble.tsx
//
// The floating chat bubble for Bogey, the Bulldog Suite AI. Sits on every
// page for managers and admins. Click to open; ask a question; Bogey reads
// from the workspace (contracts, company profile, vendor answers) via
// server-side tools and answers in plain English.
//
// v1 is deliberately simple:
//   - Single conversation per session (kept in memory + refreshed on unmount)
//   - No streaming — full request/response with a spinner
//   - No file uploads (the /vendor-profile page still handles form-fill uploads)
//   - No destructive actions — Bogey drafts, the user acts
//
// Look-and-feel: Apple Aqua bubble (bright blue → deep blue gradient with a
// glass highlight), matches the aqua-tile system already used on the landing
// page.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Sparkles,
  X,
  Send,
  Loader2,
  Square,
  MessageSquareText,
} from "lucide-react";

// Frame shapes emitted by /api/bogey/chat/stream (NDJSON, one JSON per line).
type ProposalKind = "schedule_meeting";
type ProposalStatus = "pending" | "approved" | "rejected" | "expired";

interface ProposalPayload {
  proposalId: number;
  kind: ProposalKind;
  summary: string;
  reason?: string;
  expiresAt: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  target: Record<string, unknown>;
  // Client-side lifecycle (not sent by server).
  status?: ProposalStatus;
  resolvedAt?: string;
  errorMessage?: string;
}

type StreamFrame =
  | { type: "meta"; conversationId: number }
  | { type: "delta"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; outputPreview?: string }
  | { type: "proposal"; proposal: ProposalPayload }
  | {
      type: "done";
      toolCalls?: Array<{
        tool: string;
        input: Record<string, unknown>;
        output_preview?: string;
      }>;
    }
  | { type: "error"; error: string };

interface ToolCallLog {
  tool: string;
  input: Record<string, unknown>;
  output_preview?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallLog[];
  proposals?: ProposalPayload[];
  createdAt: number;
  streaming?: boolean;
}

const STORAGE_CONV_KEY = "bogey.conversationId";

// Some pages are noisy or full-bleed and the bubble would sit on top of
// meaningful UI. Hide it there.
// Hide Bogey inside active meetings (full-bleed video UI), on auth
// pages, and on other overlays where a floating bubble would obstruct.
const HIDE_ON_PATHS: string[] = [
  "/login",
  "/sso",
  "/auth",
  "/signup",
  "/accept-invite",
  "/meeting",   // meeting rooms
  "/meetings",  // meeting rooms (plural variant)
  "/m",         // guest meeting join
  "/r",         // in-meeting room
  "/end",       // meeting-ended page
  "/huddle",    // huddle overlay
  "/call",      // active call surfaces
];

function shouldHideOnPath(path: string): boolean {
  return HIDE_ON_PATHS.some(
    (prefix) => path === prefix || path.startsWith(prefix + "/"),
  );
}

export default function BogeyBubble() {
  const { user } = useAuth();
  const [location, setLocation] = useLocation();
  const { toast } = useToast();

  const isEligible =
    user?.role === "admin" || user?.role === "manager";

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [pendingToolLabel, setPendingToolLabel] = useState<string>("");
  const [conversationId, setConversationId] = useState<number | null>(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_CONV_KEY);
      return raw ? Number(raw) || null : null;
    } catch {
      return null;
    }
  });
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const pageContext = useMemo(() => {
    // Pull a lightweight, non-sensitive summary of where the user is so
    // Bogey knows what page they're looking at when they ask questions
    // like "schedule a call for this channel at 3pm".
    const ctx: Record<string, string> = {};
    const ch = location.match(/^\/channels\/(\d+)/) || location.match(/^\/c\/([\w-]+)/);
    if (ch) ctx.channel = ch[1];
    const dm = location.match(/^\/dm\/([\w-]+)/);
    if (dm) ctx.dm = dm[1];
    const sched = location.match(/^\/scheduled\/(\d+)/);
    if (sched) ctx.scheduled_call = sched[1];
    if (location === "/" || location === "/home") ctx.section = "home";
    if (location.startsWith("/admin")) ctx.section = "admin";
    if (location.startsWith("/help")) ctx.section = "help desk";
    return ctx;
  }, [location]);

  useEffect(() => {
    if (open) {
      // Scroll to bottom whenever a new message shows up.
      const id = requestAnimationFrame(() => {
        if (listRef.current) {
          listRef.current.scrollTop = listRef.current.scrollHeight;
        }
      });
      return () => cancelAnimationFrame(id);
    }
  }, [messages, open]);

  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Update the last assistant message in place. React state updates during a
  // stream are frequent, so we do a shallow copy + swap for the tail.
  const updateAssistant = useCallback(
    (patch: (m: ChatMessage) => ChatMessage) => {
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const idx = prev.length - 1;
        const last = prev[idx];
        if (last.role !== "assistant") return prev;
        const next = prev.slice();
        next[idx] = patch(last);
        return next;
      });
    },
    [],
  );

  // Consume the NDJSON stream from /api/bogey/chat/stream, pushing text
  // deltas into the last assistant message so they render token-by-token.
  const streamChat = useCallback(
    async (text: string, signal: AbortSignal) => {
      const res = await fetch("/api/bogey/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          message: text,
          conversationId,
          pagePath: location,
          pageContext,
        }),
        signal,
      });
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        throw new Error(
          errText || `Bogey stream failed (${res.status})`,
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";
      const collectedTools: ToolCallLog[] = [];

      const handleFrame = (frame: StreamFrame) => {
        switch (frame.type) {
          case "meta": {
            if (
              frame.conversationId &&
              frame.conversationId !== conversationId
            ) {
              setConversationId(frame.conversationId);
              try {
                sessionStorage.setItem(
                  STORAGE_CONV_KEY,
                  String(frame.conversationId),
                );
              } catch {
                // ignore
              }
            }
            return;
          }
          case "delta": {
            updateAssistant((m) => ({
              ...m,
              content: m.content + frame.text,
            }));
            return;
          }
          case "tool_use": {
            setPendingToolLabel(prettyToolLabel(frame.name));
            collectedTools.push({
              tool: frame.name,
              input: frame.input,
            });
            updateAssistant((m) => ({
              ...m,
              toolCalls: collectedTools.slice(),
            }));
            return;
          }
          case "tool_result": {
            const last = collectedTools[collectedTools.length - 1];
            if (last && last.tool === frame.name) {
              last.output_preview = frame.outputPreview;
            }
            updateAssistant((m) => ({
              ...m,
              toolCalls: collectedTools.slice(),
            }));
            return;
          }
          case "proposal": {
            const p: ProposalPayload = {
              ...frame.proposal,
              status: "pending",
            };
            updateAssistant((m) => ({
              ...m,
              proposals: [...(m.proposals || []), p],
            }));
            return;
          }
          case "done": {
            if (frame.toolCalls && frame.toolCalls.length) {
              updateAssistant((m) => ({
                ...m,
                toolCalls: frame.toolCalls,
              }));
            }
            return;
          }
          case "error": {
            throw new Error(frame.error);
          }
        }
      };

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let frame: StreamFrame | null = null;
          try {
            frame = JSON.parse(line) as StreamFrame;
          } catch {
            // ignore malformed line
            continue;
          }
          handleFrame(frame);
        }
      }
      // Flush any trailing line without a newline.
      const tail = buf.trim();
      if (tail) {
        try {
          handleFrame(JSON.parse(tail) as StreamFrame);
        } catch {
          // ignore
        }
      }
    },
    [conversationId, location, pageContext, updateAssistant],
  );

  // NOTE: eligibility gating is applied at the JSX render below — do NOT
  // early-return here. Any hooks declared after this point (useMemo,
  // useCallback, useEffect, etc.) must run in the same order on every
  // render or React throws error #310 ("Rendered fewer hooks than
  // expected").

  const submit = async () => {
    const text = input.trim();
    if (!text || pending) return;
    setInput("");
    setPending(true);
    setPendingToolLabel("");
    // Push the user turn AND an empty assistant placeholder so the stream has
    // somewhere to append into.
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text, createdAt: Date.now() },
      {
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        streaming: true,
      },
    ]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamChat(text, controller.signal);
      // Mark the assistant message as done.
      updateAssistant((m) => ({ ...m, streaming: false }));
    } catch (err) {
      const isAbort =
        err instanceof DOMException && err.name === "AbortError";
      if (isAbort) {
        updateAssistant((m) => ({
          ...m,
          streaming: false,
          content: m.content || "(stopped)",
        }));
      } else {
        const description =
          err instanceof Error ? err.message : String(err);
        updateAssistant((m) => ({
          ...m,
          streaming: false,
          content: m.content || `Bogey couldn't respond: ${description}`,
        }));
        toast({
          title: "Bogey couldn't respond",
          description,
          variant: "destructive",
        });
      }
    } finally {
      setPending(false);
      setPendingToolLabel("");
      abortRef.current = null;
    }
  };

  const stopStream = () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  };

  // Approve or reject a proposal. Walks the message list and updates the
  // matching proposal's status in place.
  const resolveProposal = useCallback(
    async (proposalId: number, action: "approve" | "reject") => {
      // Optimistic UI: flip to a resolving state so buttons lock immediately.
      setMessages((prev) =>
        prev.map((m) => {
          if (!m.proposals) return m;
          const idx = m.proposals.findIndex(
            (p) => p.proposalId === proposalId,
          );
          if (idx < 0) return m;
          const next = m.proposals.slice();
          next[idx] = { ...next[idx], errorMessage: undefined };
          return { ...m, proposals: next };
        }),
      );
      try {
        const res = await fetch(
          `/api/bogey/proposals/${proposalId}/${action}`,
          {
            method: "POST",
            credentials: "include",
          },
        );
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          status?: ProposalStatus;
          resolvedAt?: string;
          error?: string;
          currentStatus?: string;
          // schedule_meeting approval returns the new meeting join URL.
          joinUrl?: string;
          meetingId?: number;
          redirectTo?: string;
          message?: string;
        };
        if (!res.ok || !body.ok) {
          const msg =
            body.error ||
            `Couldn't ${action} that proposal (${res.status}).`;
          setMessages((prev) =>
            prev.map((m) => {
              if (!m.proposals) return m;
              const idx = m.proposals.findIndex(
                (p) => p.proposalId === proposalId,
              );
              if (idx < 0) return m;
              const next = m.proposals.slice();
              next[idx] = { ...next[idx], errorMessage: msg };
              return { ...m, proposals: next };
            }),
          );
          toast({
            title: action === "approve" ? "Approve failed" : "Dismiss failed",
            description: msg,
            variant: "destructive",
          });
          return;
        }
        // Mark the proposal resolved in local state.
        setMessages((prev) =>
          prev.map((m) => {
            if (!m.proposals) return m;
            const idx = m.proposals.findIndex(
              (p) => p.proposalId === proposalId,
            );
            if (idx < 0) return m;
            const next = m.proposals.slice();
            next[idx] = {
              ...next[idx],
              status: body.status ?? (action === "approve" ? "approved" : "rejected"),
              resolvedAt: body.resolvedAt || new Date().toISOString(),
              errorMessage: undefined,
            };
            return { ...m, proposals: next };
          }),
        );
        if (action === "approve") {
          toast({
            title: "Approved",
            description:
              body.message ||
              (body.redirectTo
                ? "Bogey staged the change. Opening the next step…"
                : "Bogey applied the change."),
          });
          // PR #78 — when an approval returns a redirectTo (e.g. send_for_
          // signature staging), navigate the user to the target page so
          // they can complete the action in one click.
          const target = body.redirectTo || body.joinUrl;
          if (target && typeof target === "string" && target.startsWith("/")) {
            // Small delay so the toast is visible before the route changes.
            setTimeout(() => setLocation(target), 250);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast({
          title: action === "approve" ? "Approve failed" : "Dismiss failed",
          description: msg,
          variant: "destructive",
        });
      }
    },
    [toast],
  );

  const startFresh = () => {
    // Kill any in-flight stream first.
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setMessages([]);
    setConversationId(null);
    setPending(false);
    setPendingToolLabel("");
    try {
      sessionStorage.removeItem(STORAGE_CONV_KEY);
    } catch {
      // ignore
    }
    inputRef.current?.focus();
  };

  // Gate the render — hooks above have all executed, so hook order stays
  // stable across route changes. When the bubble should be hidden we return
  // null here instead of before the hooks.
  if (!isEligible || shouldHideOnPath(location)) {
    return null;
  }

  return (
    <>
      {/* Floating trigger */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="bogey-fab"
          aria-label="Ask Bogey"
          data-testid="bogey-fab"
        >
          <span className="bogey-fab-gloss" aria-hidden="true" />
          <Sparkles className="h-6 w-6" strokeWidth={2.25} />
        </button>
      )}

      {/* Panel */}
      {open && (
        <div
          className="bogey-panel"
          role="dialog"
          aria-label="Bogey — Bulldog Suite AI"
          data-testid="bogey-panel"
        >
          <header className="bogey-panel-header">
            <div className="flex items-center gap-2">
              <span
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/25 text-white shadow-inner"
                aria-hidden="true"
              >
                <Sparkles className="h-4 w-4" />
              </span>
              <div className="leading-tight">
                <div className="text-sm font-semibold text-white">Bogey</div>
                <div className="text-[11px] text-white/80">
                  Bulldog Suite AI · beta
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={startFresh}
                title="Start a new conversation"
                className="rounded-full p-1.5 text-white/85 transition hover:bg-white/15"
              >
                <MessageSquareText className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="Close"
                className="rounded-full p-1.5 text-white/85 transition hover:bg-white/15"
                data-testid="bogey-close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </header>

          <div className="bogey-messages" ref={listRef}>
            {messages.length === 0 ? (
              <EmptyState pageContext={pageContext} />
            ) : (
              messages.map((m, i) => (
                <MessageBubble
                  key={i}
                  message={m}
                  onResolveProposal={resolveProposal}
                />
              ))
            )}
            {pending && pendingToolLabel && (
              <div className="bogey-msg bogey-msg-assistant">
                <div className="flex items-center gap-2 text-slate-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">{pendingToolLabel}…</span>
                </div>
              </div>
            )}
          </div>

          <div className="bogey-input-row">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Ask Bogey anything — schedule a call, find a channel, help desk…"
              rows={2}
              className="resize-none border-slate-200 bg-white text-sm"
              data-testid="bogey-input"
            />
            {pending ? (
              <Button
                type="button"
                onClick={stopStream}
                className="bogey-send"
                data-testid="bogey-stop"
                title="Stop"
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                type="button"
                onClick={submit}
                disabled={!input.trim()}
                className="bogey-send"
                data-testid="bogey-send"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function EmptyState({ pageContext }: { pageContext: Record<string, string> }) {
  const section = pageContext.section || "";
  const suggestions = useMemo(() => {
    if (section === "help desk") {
      return [
        "How do I schedule a meeting with an external number?",
        "How do I mute a channel?",
        "How does DND affect push notifications?",
      ];
    }
    if (pageContext.channel) {
      return [
        "Schedule a meeting for this channel tomorrow at 3pm for 30 minutes",
        "What are my upcoming meetings for this channel?",
        "How do I set the topic on this channel?",
      ];
    }
    if (section === "admin") {
      return [
        "Show me the last 10 errors from this user",
        "Find channels tagged 'VFD Operations'",
        "What upcoming meetings do I have this week?",
      ];
    }
    return [
      "Schedule a meeting with Aaron tomorrow at 10am",
      "What upcoming meetings do I have this week?",
      "How do I start a huddle?",
    ];
  }, [section, pageContext.channel]);

  return (
    <div className="space-y-3 px-1 py-2">
      <p className="text-sm text-slate-600">
        Hi, I'm Bogey. Ask me to schedule a meeting, find a channel, or help you
        figure out how something works in Bulldog Chat.
      </p>
      <div className="space-y-1.5">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              const evt = new CustomEvent("bogey:preset", { detail: s });
              window.dispatchEvent(evt);
            }}
            className="block w-full rounded-lg border border-blue-200 bg-blue-50/60 px-3 py-2 text-left text-xs text-slate-700 transition hover:bg-blue-100/70"
          >
            {s}
          </button>
        ))}
      </div>
      <p className="pt-1 text-[11px] text-slate-400">
        Bogey drafts things and looks stuff up. He only creates meetings, sends
        invites, or makes changes after you approve.
      </p>
    </div>
  );
}

function MessageBubble({
  message,
  onResolveProposal,
}: {
  message: ChatMessage;
  onResolveProposal?: (
    proposalId: number,
    action: "approve" | "reject",
  ) => void;
}) {
  const isUser = message.role === "user";
  return (
    <div
      className={
        "bogey-msg " + (isUser ? "bogey-msg-user" : "bogey-msg-assistant")
      }
    >
      <div className="whitespace-pre-wrap text-sm leading-relaxed">
        {message.content}
        {message.streaming && (
          <span className="bogey-caret" aria-hidden="true" />
        )}
      </div>
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {message.toolCalls.map((tc, i) => (
            <Badge
              key={i}
              variant="outline"
              className="border-blue-200 bg-blue-50/70 text-[10px] font-normal text-blue-800"
              title={
                tc.output_preview
                  ? tc.output_preview.slice(0, 240)
                  : undefined
              }
            >
              {tc.tool}
            </Badge>
          ))}
        </div>
      )}
      {message.proposals && message.proposals.length > 0 && (
        <div className="mt-3 space-y-2">
          {message.proposals.map((p) => (
            <ProposalCard
              key={p.proposalId}
              proposal={p}
              onApprove={() =>
                onResolveProposal && onResolveProposal(p.proposalId, "approve")
              }
              onReject={() =>
                onResolveProposal && onResolveProposal(p.proposalId, "reject")
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProposalCard — aqua-styled draft-to-action card
// ---------------------------------------------------------------------------
// Bogey stages a change (contract status, vendor-profile field, contract note)
// and this card lets the user Approve or Dismiss. DocuSign-simple: big buttons,
// clear before → after, no jargon.

function ProposalCard({
  proposal,
  onApprove,
  onReject,
}: {
  proposal: ProposalPayload;
  onApprove: () => void;
  onReject: () => void;
}) {
  const status = proposal.status ?? "pending";
  const locked = status !== "pending";
  const kindLabel =
    proposal.kind === "schedule_meeting" ? "Schedule meeting" : "Proposal";

  // Direct-create-on-approve: clicking Approve actually creates the meeting
  // and fires invitations. Label the button honestly.
  const approveLabel = "Create meeting";

  // Build a compact before → after diff. We show whichever fields are
  // present in `after`, paired with the matching key from `before`.
  const diffRows = Object.keys(proposal.after || {}).map((key) => ({
    key,
    before: formatDiffValue((proposal.before || {})[key]),
    after: formatDiffValue((proposal.after || {})[key]),
  }));

  return (
    <div className={`bogey-proposal-card bogey-proposal-${status}`}>
      <div className="bogey-proposal-header">
        <div className="bogey-proposal-kind">{kindLabel}</div>
        <div className="bogey-proposal-summary">{proposal.summary}</div>
      </div>

      {diffRows.length > 0 && (
        <div className="bogey-proposal-diff">
          {diffRows.map((row) => (
            <div key={row.key} className="bogey-proposal-diff-row">
              <div className="bogey-proposal-diff-key">{prettyKey(row.key)}</div>
              <div className="bogey-proposal-diff-values">
                <span className="bogey-proposal-before">{row.before}</span>
                <span className="bogey-proposal-arrow">→</span>
                <span className="bogey-proposal-after">{row.after}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {proposal.reason && (
        <div className="bogey-proposal-reason">
          <span className="bogey-proposal-reason-label">Why:</span>{" "}
          {proposal.reason}
        </div>
      )}

      {proposal.errorMessage && (
        <div className="bogey-proposal-error">{proposal.errorMessage}</div>
      )}

      {locked ? (
        <div className="bogey-proposal-resolved">
          {status === "approved" && <span>✓ Approved</span>}
          {status === "rejected" && <span>✕ Dismissed</span>}
          {status === "expired" && <span>⏱ Expired</span>}
          {proposal.resolvedAt && (
            <span className="bogey-proposal-resolved-time">
              {" "}
              · {formatShortTime(proposal.resolvedAt)}
            </span>
          )}
        </div>
      ) : (
        <div className="bogey-proposal-actions">
          <button
            type="button"
            className="bogey-btn bogey-btn-approve"
            onClick={onApprove}
          >
            {approveLabel}
          </button>
          <button
            type="button"
            className="bogey-btn bogey-btn-dismiss"
            onClick={onReject}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function formatDiffValue(v: unknown): string {
  if (v == null || v === "") return "(empty)";
  if (typeof v === "string") return v.length > 120 ? v.slice(0, 117) + "…" : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + "…" : s;
  } catch {
    return String(v);
  }
}

function prettyKey(k: string): string {
  return k
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function formatShortTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

// Human-readable label for the tool badge / thinking indicator.
function prettyToolLabel(tool: string): string {
  switch (tool) {
    case "search_channels":
      return "Searching channels";
    case "get_channel":
      return "Fetching channel";
    case "list_upcoming_meetings":
      return "Checking upcoming meetings";
    case "get_meeting":
      return "Fetching meeting";
    case "propose_schedule_meeting":
      return "Drafting meeting invite";
    case "search_kb":
      return "Searching help center";
    case "get_user_diagnostics":
      return "Checking your recent errors";
    default:
      return `Running ${tool.replace(/_/g, " ")}`;
  }
}

// Preset click bridge — the EmptyState suggestions dispatch a custom event
// so the main component can pick it up without a shared context.
if (typeof window !== "undefined") {
  window.addEventListener("bogey:preset", (evt) => {
    const detail = (evt as CustomEvent).detail;
    if (typeof detail !== "string") return;
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="bogey-input"]',
    );
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (setter) setter.call(textarea, detail);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.focus();
    }
  });
}
