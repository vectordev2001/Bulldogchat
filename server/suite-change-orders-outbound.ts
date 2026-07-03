// server/suite-change-orders-outbound.ts
//
// Outbound bridge: Chat -> Bulldog Contracts (Phase 2.2 / Feature 2.2).
//
// When a foreman/PM long-presses a message and picks "Promote to Change
// Order", Chat calls this to POST /api/suite/change-orders/from-message on
// Contracts. Contracts creates a draft CO idempotent on
// (channelId, messageId), then returns { coId, coNumber, deepLink }.
//
// The caller (route handler) then persists a system message back into the
// source channel and fans it out via the local buildWireMessage helper.
//
// Auth: SUITE_INTERNAL_SECRET + x-bulldog-user-email (same pattern as the
// contracts create-meeting bridge in routes-integrations.ts).

import { storage } from "./storage";
import type { WorkObject } from "@shared/schema";

const CONTRACTS_BASE_URL = (process.env.CONTRACTS_BASE_URL || "https://vectorcontracts.bulldogops.com").replace(/\/+$/, "");

export interface PromoteInput {
  channelId: number;
  messageId: number;
  quotedText: string;
  authorEmail: string;
  authorUserId: number;
  orgId: number;
  contractId: number;
  jobId?: number;
  title?: string;
  description?: string;
}

export interface PromoteResult {
  ok: true;
  coId: number;
  coNumber: string;
  deepLink: string;
  existing: boolean;
}

export interface PromoteError {
  ok: false;
  status: number;
  message: string;
}

export async function promoteMessageToChangeOrder(
  input: PromoteInput,
): Promise<PromoteResult | PromoteError> {
  const secret = process.env.SUITE_INTERNAL_SECRET;
  if (!secret) {
    return { ok: false, status: 503, message: "SUITE_INTERNAL_SECRET not configured on chat" };
  }

  const url = `${CONTRACTS_BASE_URL}/api/suite/change-orders/from-message`;
  const payload = {
    channelId: input.channelId,
    messageId: input.messageId,
    jobId: input.jobId,
    contractId: input.contractId,
    quotedText: input.quotedText.slice(0, 10000),
    authorEmail: input.authorEmail,
    title: input.title,
    description: input.description,
  };

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-suite-secret": secret,
        "x-bulldog-user-email": input.authorEmail,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[promote-to-co] network error:", err);
    return { ok: false, status: 502, message: "Failed to reach contracts service" };
  }

  const text = await resp.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      message: (body && body.message) || `Contracts promote-to-CO failed (${resp.status})`,
    };
  }

  const coId = Number(body?.coId);
  const coNumber = String(body?.coNumber ?? "");
  const deepLink = String(body?.deepLink ?? "");
  const existing = Boolean(body?.existing);
  if (!coId || !coNumber || !deepLink) {
    return { ok: false, status: 502, message: "Contracts returned malformed response" };
  }
  return { ok: true, coId, coNumber, deepLink, existing };
}

/**
 * Build the CO-promoted system-message content + meta blob. The caller
 * (route handler) persists via storage.createMessage and fans out through
 * its private buildWireMessage helper.
 */
export function buildChangeOrderPromotedSystemMessage(params: {
  coId: number;
  coNumber: string;
  contractId: number;
  contractTitle: string;
  deepLink: string;
  quotedText: string;
  sourceMessageId: number;
  existing: boolean;
}): { content: string; meta: string } {
  const headline = params.existing
    ? `Change Order **${params.coNumber}** already exists for this message on ${params.contractTitle}`
    : `Change Order **${params.coNumber}** created on **${params.contractTitle}**`;

  const meta = {
    system: true as const,
    kind: "change_order.promoted_from_message",
    coId: params.coId,
    coNumber: params.coNumber,
    contractId: params.contractId,
    contractTitle: params.contractTitle,
    deepLink: params.deepLink,
    sourceMessageId: params.sourceMessageId,
    quotedText: params.quotedText.slice(0, 500),
    existing: params.existing,
  };
  return { content: headline, meta: JSON.stringify(meta) };
}

/**
 * Read the contract linked to the channel (populated by the
 * contracts -> chat create-channel bridge). Returns null when the channel
 * has no linkedContract JSON.
 */
export function resolveContractForChannel(channelId: number): { contractId: number; contractTitle: string } | null {
  const ch = storage.getChannel(channelId);
  if (!ch) return null;
  const lc = ch.linkedContract as { contractId?: number; title?: string } | null;
  if (!lc || typeof lc.contractId !== "number") return null;
  return { contractId: lc.contractId, contractTitle: lc.title ?? "" };
}

/**
 * Optional: pull opsJobId out of the channel's linked job_site work object.
 * Contracts CO can be created without a jobId, but linking one improves
 * downstream reporting.
 */
export function resolveJobIdForChannel(channelId: number): number | null {
  const ch = storage.getChannel(channelId);
  if (!ch || !ch.workObjectId) return null;
  const wo: WorkObject | undefined = storage.getWorkObject(ch.workObjectId);
  if (!wo || wo.kind !== "job_site") return null;
  try {
    const attrs = wo.attributes ? (JSON.parse(wo.attributes) as Record<string, unknown>) : null;
    const v = attrs?.opsJobId;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  } catch {
    /* ignore */
  }
  return null;
}
