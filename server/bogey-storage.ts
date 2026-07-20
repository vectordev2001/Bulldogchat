// Bogey storage helpers — Bulldog Suite AI in Chat.
//
// Kept in its own module (rather than bolted onto the big storage.ts) so a
// future shared bulldog-suite package can lift this out with minimal churn.
// Uses the raw better-sqlite3 handle for the same reason contracts does:
// drizzle's typed queries would add churn for a table set that's still
// evolving, and we already own the SQL.

import { rawDb } from "./db";

// ---------------------------------------------------------------------------
// Types (row-facing, in JS-native shapes — timestamps as Date, not epoch ms).
// The routes layer serializes to epoch ms at the edge.
// ---------------------------------------------------------------------------

export type BogeyProposalStatus = "pending" | "approved" | "rejected" | "expired";
export type BogeyProposalKind = "schedule_meeting";

export interface BogeyConversationRow {
  id: number;
  userId: number;
  orgId: number;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BogeyMessageRow {
  id: number;
  conversationId: number;
  role: "user" | "assistant" | "tool";
  content: unknown; // parsed JSON (array of Anthropic content blocks)
  createdAt: Date;
}

export interface BogeyProposalRow {
  id: number;
  userId: number;
  conversationId: number;
  kind: BogeyProposalKind;
  status: BogeyProposalStatus;
  payload: Record<string, unknown>;
  summary: string;
  reason: string | null;
  expiresAt: Date;
  resolvedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
}

export interface BogeyDiagnosticRow {
  id: number;
  userId: number;
  severity: "info" | "warn" | "error";
  app: string;
  code: string;
  summary: string;
  path: string | null;
  context: Record<string, unknown> | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

function convRowToRow(r: any): BogeyConversationRow {
  return {
    id: r.id,
    userId: r.user_id,
    orgId: r.org_id,
    title: r.title,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

export function createBogeyConversation(input: {
  userId: number;
  orgId: number;
  title?: string | null;
}): BogeyConversationRow {
  const now = Date.now();
  const info = rawDb
    .prepare(
      `INSERT INTO bogey_conversations (user_id, org_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.userId, input.orgId, input.title ?? null, now, now);
  const row = rawDb
    .prepare(`SELECT * FROM bogey_conversations WHERE id = ?`)
    .get(info.lastInsertRowid) as any;
  return convRowToRow(row);
}

export function getBogeyConversation(id: number, userId: number): BogeyConversationRow | null {
  const row = rawDb
    .prepare(`SELECT * FROM bogey_conversations WHERE id = ? AND user_id = ?`)
    .get(id, userId) as any;
  return row ? convRowToRow(row) : null;
}

export function listBogeyConversations(userId: number, limit = 20): BogeyConversationRow[] {
  const rows = rawDb
    .prepare(
      `SELECT * FROM bogey_conversations
       WHERE user_id = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(userId, limit) as any[];
  return rows.map(convRowToRow);
}

export function touchBogeyConversation(id: number, title?: string | null): void {
  if (title === undefined) {
    rawDb
      .prepare(`UPDATE bogey_conversations SET updated_at = ? WHERE id = ?`)
      .run(Date.now(), id);
  } else {
    rawDb
      .prepare(`UPDATE bogey_conversations SET updated_at = ?, title = ? WHERE id = ?`)
      .run(Date.now(), title, id);
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function msgRowToRow(r: any): BogeyMessageRow {
  let content: unknown = [];
  try {
    content = JSON.parse(r.content_json);
  } catch {
    content = [];
  }
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content,
    createdAt: new Date(r.created_at),
  };
}

export function appendBogeyMessage(input: {
  conversationId: number;
  role: "user" | "assistant" | "tool";
  content: unknown;
}): BogeyMessageRow {
  const info = rawDb
    .prepare(
      `INSERT INTO bogey_messages (conversation_id, role, content_json, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(input.conversationId, input.role, JSON.stringify(input.content), Date.now());
  const row = rawDb
    .prepare(`SELECT * FROM bogey_messages WHERE id = ?`)
    .get(info.lastInsertRowid) as any;
  touchBogeyConversation(input.conversationId);
  return msgRowToRow(row);
}

export function listBogeyMessages(conversationId: number, limit = 200): BogeyMessageRow[] {
  const rows = rawDb
    .prepare(
      `SELECT * FROM bogey_messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(conversationId, limit) as any[];
  return rows.map(msgRowToRow);
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

function proposalRowToRow(r: any): BogeyProposalRow {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(r.payload_json);
  } catch {
    payload = {};
  }
  return {
    id: r.id,
    userId: r.user_id,
    conversationId: r.conversation_id,
    kind: r.kind,
    status: r.status,
    payload,
    summary: r.summary,
    reason: r.reason,
    expiresAt: new Date(r.expires_at),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at) : null,
    errorMessage: r.error_message,
    createdAt: new Date(r.created_at),
  };
}

export function createBogeyProposal(input: {
  userId: number;
  conversationId: number;
  kind: BogeyProposalKind;
  payload: Record<string, unknown>;
  summary: string;
  reason?: string | null;
  ttlMinutes?: number;
}): BogeyProposalRow {
  const now = Date.now();
  const ttlMs = (input.ttlMinutes ?? 60) * 60_000;
  const info = rawDb
    .prepare(
      `INSERT INTO bogey_proposals
         (user_id, conversation_id, kind, status, payload_json, summary, reason,
          expires_at, resolved_at, error_message, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(
      input.userId,
      input.conversationId,
      input.kind,
      JSON.stringify(input.payload),
      input.summary,
      input.reason ?? null,
      now + ttlMs,
      now,
    );
  const row = rawDb
    .prepare(`SELECT * FROM bogey_proposals WHERE id = ?`)
    .get(info.lastInsertRowid) as any;
  return proposalRowToRow(row);
}

export function getBogeyProposal(id: number, userId: number): BogeyProposalRow | null {
  const row = rawDb
    .prepare(`SELECT * FROM bogey_proposals WHERE id = ? AND user_id = ?`)
    .get(id, userId) as any;
  return row ? proposalRowToRow(row) : null;
}

export function markBogeyProposalResolved(
  id: number,
  status: "approved" | "rejected" | "expired",
  errorMessage?: string | null,
): void {
  rawDb
    .prepare(
      `UPDATE bogey_proposals
       SET status = ?, resolved_at = ?, error_message = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(status, Date.now(), errorMessage ?? null, id);
}

// ---------------------------------------------------------------------------
// Diagnostic events
// ---------------------------------------------------------------------------

const DIAG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DIAG_HARD_CAP = 5000;

export function recordBogeyDiagnostic(input: {
  userId: number;
  severity: "info" | "warn" | "error";
  app: string;
  code: string;
  summary: string;
  path?: string | null;
  context?: Record<string, unknown> | null;
}): void {
  // Never let a bad diagnostic write break the caller. This is
  // fire-and-forget — chat still works if this fails.
  try {
    rawDb
      .prepare(
        `INSERT INTO bogey_diagnostic_events
           (user_id, severity, app, code, summary, path, context_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.userId | 0,
        input.severity,
        input.app,
        input.code.slice(0, 80),
        input.summary.slice(0, 500),
        input.path ? input.path.slice(0, 300) : null,
        input.context ? JSON.stringify(input.context).slice(0, 4000) : null,
        Date.now(),
      );
    if (Math.random() < 0.005) {
      pruneBogeyDiagnostics(DIAG_HARD_CAP);
    }
  } catch {
    /* swallow */
  }
}

export function listRecentBogeyDiagnostics(input: {
  userId: number;
  limit?: number;
  sinceMinutes?: number;
}): BogeyDiagnosticRow[] {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const sinceMs = (input.sinceMinutes ?? 7 * 24 * 60) * 60_000;
  const cutoff = Date.now() - sinceMs;
  const rows = rawDb
    .prepare(
      `SELECT * FROM bogey_diagnostic_events
       WHERE (user_id = ? OR user_id = 0) AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(input.userId, cutoff, limit) as any[];
  return rows.map((r) => {
    let context: Record<string, unknown> | null = null;
    if (r.context_json) {
      try {
        context = JSON.parse(r.context_json);
      } catch {
        context = null;
      }
    }
    return {
      id: r.id,
      userId: r.user_id,
      severity: r.severity,
      app: r.app,
      code: r.code,
      summary: r.summary,
      path: r.path,
      context,
      createdAt: new Date(r.created_at),
    };
  });
}

export function pruneBogeyDiagnostics(keep: number): void {
  try {
    // Time-based prune first (7d), then hard-cap the row count.
    rawDb
      .prepare(`DELETE FROM bogey_diagnostic_events WHERE created_at < ?`)
      .run(Date.now() - DIAG_RETENTION_MS);
    const row = rawDb
      .prepare(`SELECT COUNT(*) AS c FROM bogey_diagnostic_events`)
      .get() as { c: number };
    if (row.c > keep) {
      rawDb
        .prepare(
          `DELETE FROM bogey_diagnostic_events
           WHERE id IN (
             SELECT id FROM bogey_diagnostic_events
             ORDER BY created_at ASC
             LIMIT ?
           )`,
        )
        .run(row.c - keep);
    }
  } catch {
    /* swallow */
  }
}
