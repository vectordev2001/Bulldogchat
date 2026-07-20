// ---------------------------------------------------------------------------
// server/bogey-chat-routes.ts
//
// Bogey — Bulldog Suite AI assistant, Chat edition.
//
// This module wires the Anthropic-backed multi-turn tool loop for the Chat
// app's Bogey. Tools are read-only helpers over channels/meetings/diagnostics
// plus one write proposal (schedule_meeting) that goes through the normal
// Bogey proposal approve flow.
//
// Design notes:
//   * Every tool returns a compact JSON string — never dumps raw rows.
//   * The single write tool creates a proposal, not an action. The client
//     shows an Approve/Edit card; POST /api/bogey/proposals/:id/approve
//     executes.
//   * Everything is scoped by userId at the route boundary; tool inputs are
//     validated and cannot escape the current user's visibility.
//   * Hooks/streaming shape mirrors contracts' bogey-chat-routes.ts so the
//     client SSE parser is identical.
// ---------------------------------------------------------------------------

import type { Express, Request, Response, RequestHandler } from "express";
import { and, desc, eq, gte, or, sql } from "drizzle-orm";

import { db } from "./db";
import {
  channels,
  scheduledCalls,
  scheduledCallInvitees,
  users,
  channelMembers,
  messages,
  bogeyMessageInputSchema,
  type ScheduledCall,
} from "@shared/schema";
import {
  resolveAnthropicApiKey,
  resolveAnthropicModel,
} from "./anthropic-config";
import {
  createBogeyConversation,
  appendBogeyMessage,
  createBogeyProposal,
  getBogeyProposal,
  markBogeyProposalResolved,
  getBogeyConversation,
  listBogeyConversations,
  listBogeyMessages,
  listRecentBogeyDiagnostics,
  recordBogeyDiagnostic,
  touchBogeyConversation,
} from "./bogey-storage";
import { searchKb } from "./bogey-kb";

// ---------------------------------------------------------------------------
// Claude tool-use shapes (kept 1:1 with contracts' bogey-chat-routes.ts)
// ---------------------------------------------------------------------------

interface ClaudeTextBlock {
  type: "text";
  text: string;
}
interface ClaudeToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface ClaudeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock;

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

interface ClaudeResponse {
  id: string;
  content: ClaudeContentBlock[];
  stop_reason:
    | "end_turn"
    | "tool_use"
    | "max_tokens"
    | "stop_sequence"
    | string;
  usage?: { input_tokens: number; output_tokens: number };
}

interface ClaudeToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// Shape emitted to the client. Matches the client's ProposalPayload contract
// so the shared BogeyBubble component can render this without changes.
interface BogeyProposalFrame {
  proposalId: number;
  kind: string;
  summary: string;
  reason?: string;
  expiresAt: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  target: Record<string, unknown>;
  // Internal-only — kept out of the wire shape but useful to the server.
  title?: string;
  payload?: Record<string, unknown>;
  status?: "pending";
}

// ---------------------------------------------------------------------------
// Tool registry — Chat edition
// ---------------------------------------------------------------------------

const TOOLS: ClaudeToolSpec[] = [
  {
    name: "search_channels",
    description:
      "Search the current user's visible channels by name or description. Returns up to 10 matches. Use this when the user names a channel or asks 'where does X get discussed?'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query, matched against channel name and description." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_channel",
    description:
      "Get details for one channel by id. Includes name, description, privacy, member count, and last activity. Use this after search_channels to answer specific questions.",
    input_schema: {
      type: "object",
      properties: {
        channelId: { type: "number", description: "Channel id from search_channels." },
      },
      required: ["channelId"],
    },
  },
  {
    name: "list_upcoming_meetings",
    description:
      "List scheduled meetings for the current user in the next N days (default 7). Use this to answer 'what meetings do I have?' or 'when am I meeting with X?'.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Look ahead this many days (default 7, max 30)." },
        channelId: { type: "number", description: "Optional: restrict to a specific channel." },
      },
    },
  },
  {
    name: "get_meeting",
    description:
      "Get full details for one meeting: title, times, attendees, notes, join URL. Use this after list_upcoming_meetings to answer specific questions.",
    input_schema: {
      type: "object",
      properties: {
        meetingId: { type: "number" },
      },
      required: ["meetingId"],
    },
  },
  {
    name: "propose_schedule_meeting",
    description:
      "Draft a meeting for the user to review and approve. This does NOT create the meeting — it creates a proposal card. The user must approve it. Provide as much detail as you have from the conversation; ask the user for missing required fields (title, start, end) before calling this tool.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short meeting title, e.g. 'Q3 planning review'." },
        startAt: {
          type: "string",
          description:
            "ISO 8601 datetime with timezone offset, e.g. '2026-07-20T10:00:00-07:00'. Interpret vague times using the user's local timezone from pageContext.",
        },
        endAt: {
          type: "string",
          description: "ISO 8601 datetime. Must be after startAt. Default duration 30 minutes if user didn't specify.",
        },
        channelId: {
          type: "number",
          description: "Optional: post the meeting into this channel and invite its members.",
        },
        userIds: {
          type: "array",
          items: { type: "number" },
          description: "Optional: explicit user IDs to invite.",
        },
        phones: {
          type: "array",
          items: { type: "string" },
          description: "Optional: external guest phone numbers in E.164 (+1XXXXXXXXXX).",
        },
        emails: {
          type: "array",
          items: { type: "string" },
          description: "Optional: external guest emails.",
        },
        notes: {
          type: "string",
          description: "Optional agenda or notes to attach to the meeting card.",
        },
      },
      required: ["title", "startAt", "endAt"],
    },
  },
  {
    name: "search_kb",
    description:
      "Search Bogey's knowledge base of Bulldog Chat how-to docs (channels, DMs, meetings, calling, scheduling, notifications, help-desk). Returns a short excerpt with source path. Use this when the user asks 'how do I…' or 'what does X do?'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_user_diagnostics",
    description:
      "Get recent server-side errors recorded against the current user (last 20). Use this when the user says something is broken, an upload failed, or they're seeing errors. Explain the errors in plain language — don't dump raw stack traces.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

interface ToolCtx {
  userId: number;
  userName: string;
  userEmail: string;
  userRole: string;
  now: Date;
}

function respond(ok: boolean, payload: unknown): string {
  return JSON.stringify(ok ? { ok: true, ...payload as object } : { ok: false, error: payload });
}

function toolSearchChannels(input: Record<string, unknown>, ctx: ToolCtx): string {
  const raw = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
  if (!raw) return respond(false, "query is required");
  const like = `%${raw.replace(/[%_]/g, "\\$&")}%`;

  // Access model: user must be a member (channelMembers row) OR the channel
  // is a global/company-wide scope channel (scope='global') in a project the
  // user has any grant on. To keep this simple and safe we require
  // membership — companywide channels are always joined by default via the
  // seed flow so this covers 99% of cases.
  const rows = db
    .select({
      id: channels.id,
      name: channels.name,
      topic: channels.topic,
      title: channels.title,
      scope: channels.scope,
      createdAt: channels.createdAt,
    })
    .from(channels)
    .innerJoin(
      channelMembers,
      and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, ctx.userId)),
    )
    .where(
      or(
        sql`lower(${channels.name}) LIKE ${like} ESCAPE '\\'`,
        sql`lower(coalesce(${channels.topic}, '')) LIKE ${like} ESCAPE '\\'`,
        sql`lower(coalesce(${channels.title}, '')) LIKE ${like} ESCAPE '\\'`,
      ),
    )
    .orderBy(desc(channels.createdAt))
    .limit(10)
    .all() as any[];

  return respond(true, {
    channels: rows.map((r) => ({
      id: r.id,
      name: r.name,
      topic: (r.topic || "").slice(0, 140),
      title: r.title || null,
      scope: r.scope,
    })),
  });
}

function toolGetChannel(input: Record<string, unknown>, ctx: ToolCtx): string {
  const id = Number(input.channelId);
  if (!Number.isFinite(id) || id <= 0) return respond(false, "channelId must be a positive number");

  const ch = db.select().from(channels).where(eq(channels.id, id)).get() as any;
  if (!ch) return respond(false, "channel not found");

  // Access check: user must be a member.
  const mem = db
    .select({ id: channelMembers.userId })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, id), eq(channelMembers.userId, ctx.userId)))
    .get();
  if (!mem) return respond(false, "you don't have access to this channel");

  const memberCount = (db
    .select({ n: sql<number>`count(*)` })
    .from(channelMembers)
    .where(eq(channelMembers.channelId, id))
    .get() as any)?.n ?? 0;

  const lastMsg = db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.channelId, id))
    .orderBy(desc(messages.createdAt))
    .limit(1)
    .get() as any;

  return respond(true, {
    channel: {
      id: ch.id,
      name: ch.name,
      topic: ch.topic || "",
      title: ch.title || null,
      scope: ch.scope,
      type: ch.type,
      memberCount: Number(memberCount),
      lastMessageAt: lastMsg?.createdAt instanceof Date ? lastMsg.createdAt.toISOString() : lastMsg?.createdAt || null,
    },
  });
}

function toolListUpcomingMeetings(input: Record<string, unknown>, ctx: ToolCtx): string {
  const daysRaw = Number(input.days);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 30 ? Math.floor(daysRaw) : 7;
  const channelId = Number(input.channelId);
  const now = ctx.now;
  const end = new Date(now.getTime() + days * 24 * 3600 * 1000);

  // startAt is stored as timestamp (Date). Drizzle handles Date <-> integer
  // conversion for us, so pass Date objects.
  const conds = [gte(scheduledCalls.startAt, now)];
  if (Number.isFinite(channelId) && channelId > 0) {
    conds.push(eq(scheduledCalls.channelId, channelId));
  }

  const rows = db
    .select({
      id: scheduledCalls.id,
      title: scheduledCalls.title,
      startAt: scheduledCalls.startAt,
      endAt: scheduledCalls.endAt,
      channelId: scheduledCalls.channelId,
      organizerId: scheduledCalls.organizerId,
      notes: scheduledCalls.notes,
      kind: scheduledCalls.kind,
      status: scheduledCalls.status,
    })
    .from(scheduledCalls)
    .where(and(...conds))
    .orderBy(scheduledCalls.startAt)
    .limit(30)
    .all() as any[];

  // Filter to meetings visible to user: they organize it, they're a member
  // of the bound channel, or they're an invitee (scheduledCallInvitees).
  const visible = rows.filter((r) => {
    if (r.status === "cancelled") return false;
    if (r.organizerId === ctx.userId) return true;
    if (r.channelId) {
      const mem = db
        .select({ n: sql<number>`count(*)` })
        .from(channelMembers)
        .where(and(eq(channelMembers.channelId, r.channelId), eq(channelMembers.userId, ctx.userId)))
        .get() as any;
      if ((mem?.n ?? 0) > 0) return true;
    }
    // Also check invitees table for direct invite.
    try {
      const invitee = db
        .select({ n: sql<number>`count(*)` })
        .from(scheduledCallInvitees)
        .where(and(
          eq(scheduledCallInvitees.scheduledCallId, r.id),
          eq(scheduledCallInvitees.userId, ctx.userId),
        ))
        .get() as any;
      return (invitee?.n ?? 0) > 0;
    } catch {
      return false;
    }
  });

  return respond(true, {
    meetings: visible.slice(0, 10).map((r) => ({
      id: r.id,
      title: r.title,
      startAt: r.startAt instanceof Date ? r.startAt.toISOString() : r.startAt,
      endAt: r.endAt instanceof Date ? r.endAt.toISOString() : r.endAt,
      channelId: r.channelId,
      kind: r.kind || "video",
      status: r.status,
      hasNotes: Boolean(r.notes),
    })),
    windowDays: days,
    endsAt: end.toISOString(),
  });
}

function toolGetMeeting(input: Record<string, unknown>, ctx: ToolCtx): string {
  const id = Number(input.meetingId);
  if (!Number.isFinite(id) || id <= 0) return respond(false, "meetingId must be a positive number");

  const m = db.select().from(scheduledCalls).where(eq(scheduledCalls.id, id)).get() as any;
  if (!m) return respond(false, "meeting not found");

  // Access: organizer, channel member, or explicit invitee.
  let hasAccess = m.organizerId === ctx.userId;
  if (!hasAccess && m.channelId) {
    const mem = db
      .select({ n: sql<number>`count(*)` })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, m.channelId), eq(channelMembers.userId, ctx.userId)))
      .get() as any;
    if ((mem?.n ?? 0) > 0) hasAccess = true;
  }
  if (!hasAccess) {
    try {
      const inv = db
        .select({ n: sql<number>`count(*)` })
        .from(scheduledCallInvitees)
        .where(and(
          eq(scheduledCallInvitees.scheduledCallId, m.id),
          eq(scheduledCallInvitees.userId, ctx.userId),
        ))
        .get() as any;
      if ((inv?.n ?? 0) > 0) hasAccess = true;
    } catch { /* ignore */ }
  }
  if (!hasAccess) return respond(false, "you don't have access to this meeting");

  return respond(true, {
    meeting: {
      id: m.id,
      title: m.title,
      startAt: m.startAt instanceof Date ? m.startAt.toISOString() : m.startAt,
      endAt: m.endAt instanceof Date ? m.endAt.toISOString() : m.endAt,
      channelId: m.channelId,
      kind: m.kind || "video",
      status: m.status,
      notes: (m.notes || "").slice(0, 800),
      organizerId: m.organizerId,
      roomName: m.roomName,
      teamsJoinUrl: m.teamsJoinUrl || null,
    },
  });
}

function toolProposeScheduleMeeting(
  input: Record<string, unknown>,
  ctx: ToolCtx,
  conversationId: number,
): { toolResult: string; proposal?: BogeyProposalFrame } {
  const title = String(input.title || "").trim();
  const startAt = String(input.startAt || "").trim();
  const endAt = String(input.endAt || "").trim();

  if (!title) return { toolResult: respond(false, "title is required") };
  if (!startAt || !endAt) return { toolResult: respond(false, "startAt and endAt are required") };

  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs)) return { toolResult: respond(false, "startAt could not be parsed as ISO 8601") };
  if (!Number.isFinite(endMs)) return { toolResult: respond(false, "endAt could not be parsed as ISO 8601") };
  if (endMs <= startMs) return { toolResult: respond(false, "endAt must be after startAt") };
  if (startMs < ctx.now.getTime() - 60_000) return { toolResult: respond(false, "startAt is in the past") };

  const channelIdRaw = input.channelId;
  const channelId = Number.isFinite(Number(channelIdRaw)) && Number(channelIdRaw) > 0
    ? Number(channelIdRaw)
    : undefined;

  const userIds = Array.isArray(input.userIds)
    ? input.userIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const phones = Array.isArray(input.phones)
    ? input.phones.map((p) => String(p).trim()).filter((p) => /^\+?[\d\-() ]{7,20}$/.test(p))
    : [];
  const emails = Array.isArray(input.emails)
    ? input.emails.map((e) => String(e).trim()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
    : [];
  const notes = typeof input.notes === "string" ? input.notes.slice(0, 2000) : "";

  const payload = {
    title: title.slice(0, 200),
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    channelId,
    userIds,
    phones,
    emails,
    notes,
  };

  const durationMin = Math.round((endMs - startMs) / 60000);
  const localStart = new Date(startMs).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const inviteeBits: string[] = [];
  if (channelId) inviteeBits.push(`channel #${channelId}`);
  if (userIds.length) inviteeBits.push(`${userIds.length} user${userIds.length === 1 ? "" : "s"}`);
  if (phones.length) inviteeBits.push(`${phones.length} phone${phones.length === 1 ? "" : "s"}`);
  if (emails.length) inviteeBits.push(`${emails.length} email${emails.length === 1 ? "" : "s"}`);
  const summary = `${localStart} • ${durationMin} min${inviteeBits.length ? " • " + inviteeBits.join(", ") : ""}`;

  const displayTitle = `Schedule: ${title.slice(0, 60)}`;
  const proposal = createBogeyProposal({
    conversationId,
    userId: ctx.userId,
    kind: "schedule_meeting",
    summary,
    payload,
  });

  return {
    toolResult: respond(true, {
      proposal: {
        id: proposal.id,
        kind: proposal.kind,
        title: displayTitle,
        summary: proposal.summary,
      },
      message: "Proposal drafted. The user needs to click Approve to actually create the meeting.",
    }),
    proposal: {
      proposalId: proposal.id,
      kind: proposal.kind,
      summary: proposal.summary,
      reason: proposal.reason ?? undefined,
      expiresAt: proposal.expiresAt instanceof Date
        ? proposal.expiresAt.toISOString()
        : new Date(proposal.expiresAt as any).toISOString(),
      before: {},
      after: {
        title,
        when: localStart,
        duration_min: durationMin,
        invitees:
          [
            ...userIds.map((u) => `user #${u}`),
            ...phones,
            ...emails,
          ].slice(0, 12).join(", ") || "(none)",
      },
      target: {
        channel_id: payload.channelId ?? null,
      },
      // Internal-only.
      title: displayTitle,
      payload: proposal.payload as Record<string, unknown>,
      status: "pending",
    },
  };
}

function toolSearchKb(input: Record<string, unknown>): string {
  const q = typeof input.query === "string" ? input.query.trim() : "";
  if (!q) return respond(false, "query is required");
  const hits = searchKb(q, { limit: 3 });
  return respond(true, {
    results: hits.map((h) => ({
      title: h.title,
      path: h.path,
      snippet: h.snippet,
    })),
  });
}

function toolGetUserDiagnostics(_input: Record<string, unknown>, ctx: ToolCtx): string {
  const rows = listRecentBogeyDiagnostics({ userId: ctx.userId, limit: 20 });
  return respond(true, {
    events: rows.map((r) => ({
      id: r.id,
      app: r.app,
      code: r.code,
      severity: r.severity,
      summary: (r.summary || "").slice(0, 300),
      path: r.path || "",
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    })),
  });
}

function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolCtx,
  conversationId: number,
  proposalsLog: BogeyProposalFrame[],
): string {
  try {
    switch (name) {
      case "search_channels":
        return toolSearchChannels(input, ctx);
      case "get_channel":
        return toolGetChannel(input, ctx);
      case "list_upcoming_meetings":
        return toolListUpcomingMeetings(input, ctx);
      case "get_meeting":
        return toolGetMeeting(input, ctx);
      case "propose_schedule_meeting": {
        const { toolResult, proposal } = toolProposeScheduleMeeting(input, ctx, conversationId);
        if (proposal) proposalsLog.push(proposal);
        return toolResult;
      }
      case "search_kb":
        return toolSearchKb(input);
      case "get_user_diagnostics":
        return toolGetUserDiagnostics(input, ctx);
      default:
        return respond(false, `unknown tool: ${name}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Record a diagnostic so we can trace tool failures later.
    try {
      recordBogeyDiagnostic({
        userId: ctx.userId,
        app: "chat",
        code: `bogey_tool_${name}`,
        severity: "warn",
        summary: `Tool ${name} threw: ${msg}`,
        path: `/api/bogey/chat`,
        context: { tool: name, input: safePreview(input) },
      });
    } catch { /* swallow */ }
    return respond(false, `tool error: ${msg.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Claude call
// ---------------------------------------------------------------------------

async function callClaudeWithTools(params: {
  system: string;
  messages: ClaudeMessage[];
  tools: ClaudeToolSpec[];
  model: string;
  maxTokens: number;
}): Promise<ClaudeResponse> {
  const apiKey = resolveAnthropicApiKey();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      tools: params.tools,
      messages: params.messages,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 400)}`);
  }
  return (await res.json()) as ClaudeResponse;
}

// ---------------------------------------------------------------------------
// System prompt (persona)
// ---------------------------------------------------------------------------

function systemPrompt(ctx: {
  path: string;
  context: Record<string, string>;
  userName: string;
  role: string;
}): string {
  const isAdmin = /admin|owner|super/i.test(ctx.role);
  const persona = [
    "You are **Bogey**, the Bulldog Suite AI assistant, embedded in the Bulldog Chat app.",
    "You help users get things done inside Bulldog Chat: finding channels, understanding how features work, scheduling meetings, and troubleshooting problems.",
    "You are NOT Vinny (Vinny is the legal / contract review AI, in a different app). Do not offer legal or contract-review advice — redirect the user to Vinny in Bulldog Contracts.",
    "You are also Bulldog's **Help Desk** — if a user is stuck or seeing errors, help them, and if you can't, offer to open a support ticket.",
    "",
    "## Voice",
    "- Warm, direct, plain-English. Docusign-simple. No jargon.",
    "- Short answers by default. Expand when the user asks 'why' or 'how'.",
    "- Never invent facts. If you don't know, say so and offer to look it up with a tool.",
    "",
    "## Tools",
    "- `search_channels` / `get_channel` — for channel questions.",
    "- `list_upcoming_meetings` / `get_meeting` — for meeting questions.",
    "- `propose_schedule_meeting` — to draft a new meeting. This creates a proposal card. The user MUST approve it before the meeting is created. Do NOT tell the user the meeting is scheduled after calling this tool — say you've drafted it and ask them to review.",
    "- `search_kb` — for how-to questions (channels, DMs, meetings, calling, scheduling, notifications, help-desk).",
    "- `get_user_diagnostics` — when the user reports something is broken.",
    "",
    "## Scheduling flow",
    "When the user asks to schedule a meeting:",
    "1. Collect: title, start time, end time (or duration), attendees.",
    "2. Ask ONE follow-up if any required field is missing. Don't interrogate.",
    "3. Interpret times in the user's timezone (from page context). Always emit ISO 8601 with offset.",
    "4. Call `propose_schedule_meeting`.",
    "5. Reply: 'Drafted — review and approve to schedule.' Do NOT claim the meeting is on the calendar.",
    "",
    "## Diagnostics flow",
    "When the user says something is broken or asks about errors:",
    "1. Call `get_user_diagnostics`.",
    "2. Read the last few events and explain in plain language what likely happened.",
    "3. If it looks like a bug, offer to open a support ticket (you don't have that tool yet — just tell the user you'll flag it and they can email support).",
    "",
    "## Refuse gracefully",
    "- Contract review, legal advice → 'That's Vinny's area — try the Bogey bubble inside Bulldog Contracts.'",
    "- Field ops actions (dispatching crews, DFRs) → 'Try Bogey inside Bulldog Ops.'",
    "- Anything requiring admin powers you don't have → say so and suggest the user do it manually or ask an admin.",
    "",
  ].join("\n");

  const ctxBlock = [
    "## Current page context",
    `- User: ${ctx.userName || "(unknown)"} ${isAdmin ? "(admin)" : ""}`,
    `- Path: ${ctx.path || "(unknown)"}`,
    ...Object.entries(ctx.context || {}).map(([k, v]) => `- ${k}: ${String(v).slice(0, 200)}`),
    `- Server time: ${new Date().toISOString()}`,
  ].join("\n");

  const adminBlock = isAdmin
    ? [
      "",
      "## Admin-only capabilities",
      "You are talking to an admin. You may:",
      "- Suggest workspace-wide changes (adding channels, changing SMS opt-in defaults).",
      "- Explain feature toggles.",
      "You still cannot execute admin writes directly — everything goes through the normal approval flow.",
    ].join("\n")
    : "";

  return persona + "\n" + ctxBlock + adminBlock;
}

function safePreview(value: unknown): string {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > 400 ? s.slice(0, 400) + "…" : s;
  } catch {
    return "[unserializable]";
  }
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

// The client parses NDJSON — one JSON object per line. Emit the same
// frame shape contracts uses so the shared BogeyBubble can consume it.
function sseWrite(res: Response, event: string, data: unknown) {
  const merged: Record<string, unknown> = { type: event };
  if (data && typeof data === "object") Object.assign(merged, data);
  else if (data !== undefined) merged.data = data;
  res.write(JSON.stringify(merged) + "\n");
}

// ---------------------------------------------------------------------------
// Endpoint registration
// ---------------------------------------------------------------------------

const MAX_TOOL_TURNS = 4;

export function registerBogeyChatRoutes(app: Express, requireAccess: RequestHandler) {
  // ---- List conversations for the current user ----------------------------
  app.get("/api/bogey/conversations", requireAccess, (req: Request, res: Response) => {
    const user = (req.user as { id?: number } | undefined) ?? {};
    if (!user.id) return res.status(401).json({ error: "unauthenticated" });
    const rows = listBogeyConversations(user.id, 20);
    res.json({ conversations: rows });
  });

  app.get("/api/bogey/conversations/:id", requireAccess, (req: Request, res: Response) => {
    const user = (req.user as { id?: number } | undefined) ?? {};
    if (!user.id) return res.status(401).json({ error: "unauthenticated" });
    const id = Number(req.params.id);
    const conv = getBogeyConversation(id, user.id);
    if (!conv) return res.status(404).json({ error: "not found" });
    const msgs = listBogeyMessages(id, 500);
    res.json({ conversation: conv, messages: msgs });
  });

  // ---- Non-streaming chat (fallback) --------------------------------------
  app.post("/api/bogey/chat", requireAccess, async (req: Request, res: Response) => {
    const user = (req.user as { id?: number; role?: string; name?: string; email?: string } | undefined) ?? {};
    if (!user.id) return res.status(401).json({ error: "unauthenticated" });

    const parsed = bogeyMessageInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const { message, pagePath, pageContext, conversationId } = parsed.data;

    // Resolve user's org (required for scoping conversations to the tenant).
    const uRow = db.select({ orgId: users.orgId }).from(users).where(eq(users.id, user.id)).get() as any;
    if (!uRow?.orgId) return res.status(500).json({ error: "user has no orgId" });

    let conv = conversationId ? getBogeyConversation(conversationId, user.id) : null;
    if (!conv) {
      conv = createBogeyConversation({
        userId: user.id,
        orgId: uRow.orgId,
        title: message.slice(0, 80),
      });
    }
    appendBogeyMessage({
      conversationId: conv.id,
      role: "user",
      content: { text: message, pagePath: pagePath || "", pageContext: pageContext || {} },
    });

    const history = listBogeyMessages(conv.id, 500).slice(-40);
    const messagesList: ClaudeMessage[] = [];
    for (const m of history) {
      const c = m.content as any;
      const text = typeof c === "string" ? c : (c?.text || c?.content || "");
      if (!text) continue;
      if (m.role === "user") messagesList.push({ role: "user", content: text });
      else if (m.role === "assistant") messagesList.push({ role: "assistant", content: text });
    }

    const { model } = resolveAnthropicModel();
    const system = systemPrompt({
      path: pagePath || "",
      context: pageContext || {},
      userName: user.name || user.email || "",
      role: user.role || "",
    });

    const ctx: ToolCtx = {
      userId: user.id,
      userName: user.name || "",
      userEmail: user.email || "",
      userRole: user.role || "",
      now: new Date(),
    };

    let toolTurns = 0;
    const proposalsLog: BogeyProposalFrame[] = [];
    let finalText = "";

    while (toolTurns <= MAX_TOOL_TURNS) {
      let result: ClaudeResponse;
      try {
        result = await callClaudeWithTools({
          system,
          messages: messagesList,
          tools: TOOLS,
          model,
          maxTokens: 1024,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordBogeyDiagnostic({
          userId: user.id,
          app: "chat",
          code: "bogey_claude_error",
          severity: "error",
          summary: msg.slice(0, 500),
          path: "/api/bogey/chat",
          context: {},
        });
        return res.status(502).json({ error: "AI service unavailable", detail: msg.slice(0, 200) });
      }

      const textBlocks = result.content.filter((c): c is ClaudeTextBlock => c.type === "text");
      const toolUses = result.content.filter((c): c is ClaudeToolUseBlock => c.type === "tool_use");
      finalText = textBlocks.map((b) => b.text).join("\n").trim();

      if (result.stop_reason !== "tool_use" || toolUses.length === 0) break;

      // Append assistant tool_use turn.
      messagesList.push({ role: "assistant", content: result.content });

      // Execute each tool, append tool_result turn.
      const results: ClaudeToolResultBlock[] = [];
      for (const tu of toolUses) {
        const out = runTool(tu.name, tu.input, ctx, conv.id, proposalsLog);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      messagesList.push({ role: "user", content: results });

      toolTurns++;
    }

    appendBogeyMessage({
      conversationId: conv.id,
      role: "assistant",
      content: { text: finalText || "(no response)", pagePath: pagePath || "" },
    });
    touchBogeyConversation(conv.id);

    return res.json({
      conversationId: conv.id,
      text: finalText,
      proposals: proposalsLog,
    });
  });

  // ---- SSE streaming endpoint ---------------------------------------------
  app.post("/api/bogey/chat/stream", requireAccess, async (req: Request, res: Response) => {
    const user = (req.user as { id?: number; role?: string; name?: string; email?: string } | undefined) ?? {};
    if (!user.id) return res.status(401).json({ error: "unauthenticated" });

    const parsed = bogeyMessageInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const { message, pagePath, pageContext, conversationId } = parsed.data;

    const uRow2 = db.select({ orgId: users.orgId }).from(users).where(eq(users.id, user.id)).get() as any;
    if (!uRow2?.orgId) return res.status(500).json({ error: "user has no orgId" });

    let conv = conversationId ? getBogeyConversation(conversationId, user.id) : null;
    if (!conv) {
      conv = createBogeyConversation({
        userId: user.id,
        orgId: uRow2.orgId,
        title: message.slice(0, 80),
      });
    }
    appendBogeyMessage({
      conversationId: conv.id,
      role: "user",
      content: { text: message, pagePath: pagePath || "", pageContext: pageContext || {} },
    });

    // NDJSON — matches the frame shape the shared BogeyBubble client expects.
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    sseWrite(res, "meta", { conversationId: conv.id });

    const history = listBogeyMessages(conv.id, 500).slice(-40);
    const messagesList: ClaudeMessage[] = [];
    for (const m of history) {
      const c = m.content as any;
      const text = typeof c === "string" ? c : (c?.text || c?.content || "");
      if (!text) continue;
      if (m.role === "user") messagesList.push({ role: "user", content: text });
      else if (m.role === "assistant") messagesList.push({ role: "assistant", content: text });
    }

    const { model } = resolveAnthropicModel();
    const system = systemPrompt({
      path: pagePath || "",
      context: pageContext || {},
      userName: user.name || user.email || "",
      role: user.role || "",
    });
    const ctx: ToolCtx = {
      userId: user.id,
      userName: user.name || "",
      userEmail: user.email || "",
      userRole: user.role || "",
      now: new Date(),
    };

    let toolTurns = 0;
    const proposalsLog: BogeyProposalFrame[] = [];
    let finalText = "";

    try {
      while (toolTurns <= MAX_TOOL_TURNS) {
        const result = await callClaudeWithTools({
          system,
          messages: messagesList,
          tools: TOOLS,
          model,
          maxTokens: 1024,
        });

        const textBlocks = result.content.filter((c): c is ClaudeTextBlock => c.type === "text");
        const toolUses = result.content.filter((c): c is ClaudeToolUseBlock => c.type === "tool_use");
        const stepText = textBlocks.map((b) => b.text).join("\n").trim();
        if (stepText) {
          sseWrite(res, "delta", { text: stepText });
          finalText = stepText;
        }

        if (result.stop_reason !== "tool_use" || toolUses.length === 0) break;

        messagesList.push({ role: "assistant", content: result.content });

        const results: ClaudeToolResultBlock[] = [];
        for (const tu of toolUses) {
          sseWrite(res, "tool_use", { name: tu.name, input: tu.input });
          const out = runTool(tu.name, tu.input, ctx, conv.id, proposalsLog);
          results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
        }
        messagesList.push({ role: "user", content: results });
        toolTurns++;
      }

      for (const p of proposalsLog) {
        sseWrite(res, "proposal", { proposal: p });
      }

      appendBogeyMessage({
        conversationId: conv.id,
        role: "assistant",
        content: { text: finalText || "(no response)", pagePath: pagePath || "" },
      });
      touchBogeyConversation(conv.id);

      sseWrite(res, "done", { conversationId: conv.id });
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordBogeyDiagnostic({
        userId: user.id,
        app: "chat",
        code: "bogey_stream_error",
        severity: "error",
        summary: msg.slice(0, 500),
        path: "/api/bogey/chat/stream",
        context: {},
      });
      sseWrite(res, "error", { error: msg.slice(0, 200) });
      res.end();
    }
  });

  // ---- Approve a proposal --------------------------------------------------
  app.post("/api/bogey/proposals/:id/approve", requireAccess, async (req: Request, res: Response) => {
    const user = (req.user as { id?: number } | undefined) ?? {};
    if (!user.id) return res.status(401).json({ error: "unauthenticated" });
    const id = Number(req.params.id);
    const p = getBogeyProposal(id, user.id);
    if (!p) return res.status(404).json({ error: "proposal not found" });
    if (p.status !== "pending") {
      return res.status(409).json({ error: `proposal already ${p.status}` });
    }

    // Optional overrides from client (user tweaked the card before approving).
    const overrides = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const payload = { ...(p.payload as Record<string, unknown>), ...overrides };

    if (p.kind === "schedule_meeting") {
      try {
        // Resolve the user's org (required column on scheduled_calls).
        const u = db.select({ orgId: users.orgId }).from(users).where(eq(users.id, user.id)).get() as any;
        if (!u?.orgId) throw new Error("user has no orgId");

        const created = createScheduledCall({
          title: String(payload.title || ""),
          startAt: String(payload.startAt || ""),
          endAt: String(payload.endAt || ""),
          channelId: Number(payload.channelId) || null,
          userIds: Array.isArray(payload.userIds) ? payload.userIds.map(Number).filter(Boolean) : [],
          phones: Array.isArray(payload.phones) ? payload.phones.map(String) : [],
          emails: Array.isArray(payload.emails) ? payload.emails.map(String) : [],
          notes: String(payload.notes || ""),
          createdBy: user.id,
          orgId: u.orgId,
        });
        markBogeyProposalResolved(id, "approved");
        return res.json({
          ok: true,
          meetingId: created.id,
          joinUrl: `/meetings/${created.id}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordBogeyDiagnostic({
          userId: user.id,
          app: "chat",
          code: "bogey_approve_error",
          severity: "error",
          summary: msg.slice(0, 500),
          path: `/api/bogey/proposals/${id}/approve`,
          context: { kind: p.kind },
        });
        return res.status(500).json({ error: "failed to execute proposal", detail: msg.slice(0, 300) });
      }
    }

    return res.status(400).json({ error: `unknown proposal kind: ${p.kind}` });
  });

  app.post("/api/bogey/proposals/:id/reject", requireAccess, (req: Request, res: Response) => {
    const user = (req.user as { id?: number } | undefined) ?? {};
    if (!user.id) return res.status(401).json({ error: "unauthenticated" });
    const id = Number(req.params.id);
    const p = getBogeyProposal(id, user.id);
    if (!p) return res.status(404).json({ error: "proposal not found" });
    if (p.status !== "pending") {
      return res.status(409).json({ error: `proposal already ${p.status}` });
    }
    markBogeyProposalResolved(id, "rejected");
    return res.json({ ok: true });
  });
}

// ---------------------------------------------------------------------------
// Local wrapper to create a scheduled call directly (bypasses the HTTP
// endpoint at server/scheduled-calls.ts:1481 so we don't have to make an
// internal fetch). Uses the same table shape.
// ---------------------------------------------------------------------------

function createScheduledCall(input: {
  title: string;
  startAt: string;
  endAt: string;
  channelId: number | null;
  userIds: number[];
  phones: string[];
  emails: string[];
  notes: string;
  createdBy: number;
  orgId: number;
}): ScheduledCall {
  const startDate = new Date(input.startAt);
  const endDate = new Date(input.endAt);
  const now = new Date();
  // Room name pattern matches the existing scheduled-call flow
  // (server/scheduled-calls.ts): `sched-<id>-<ts>`. We don't know the id
  // yet so use a placeholder that we could later rename; but since the
  // existing code just uses this as a LiveKit room identifier, generating
  // a unique string up-front is fine.
  const roomName = `sched-bogey-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const inserted = db
    .insert(scheduledCalls)
    .values({
      title: input.title.slice(0, 200),
      startAt: startDate,
      endAt: endDate,
      channelId: input.channelId || undefined,
      organizerId: input.createdBy,
      orgId: input.orgId,
      notes: input.notes.slice(0, 4000),
      kind: "video",
      status: "scheduled",
      roomName,
      createdAt: now,
      updatedAt: now,
    } as any)
    .returning()
    .get() as ScheduledCall;

  // Fan out invitees. Failures here don't roll back the meeting — the
  // organizer can re-invite from the UI if any invitee row fails to insert.
  const genRsvpCode = () =>
    Array.from({ length: 4 }, () =>
      "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".charAt(Math.floor(Math.random() * 32)),
    ).join("");
  for (const uid of input.userIds) {
    try {
      db.insert(scheduledCallInvitees).values({
        scheduledCallId: inserted.id,
        userId: uid,
        rsvpCode: genRsvpCode(),
      } as any).run();
    } catch { /* dedupe / bad-id — ignore */ }
  }
  for (const phone of input.phones) {
    try {
      db.insert(scheduledCallInvitees).values({
        scheduledCallId: inserted.id,
        externalPhone: phone,
        rsvpCode: genRsvpCode(),
      } as any).run();
    } catch { /* ignore */ }
  }
  for (const email of input.emails) {
    try {
      db.insert(scheduledCallInvitees).values({
        scheduledCallId: inserted.id,
        rsvpCode: genRsvpCode(),
        externalEmail: email,
      } as any).run();
    } catch { /* ignore */ }
  }

  return inserted;
}
