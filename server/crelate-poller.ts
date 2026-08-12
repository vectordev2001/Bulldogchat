// PR #146 — Crelate scoreboard poller.
//
// Every 3 minutes, this poller pulls three signals from Crelate's public
// API3 into a local cache the recruiter scorecard reads from:
//
//   - Open requisitions      (/api3/jobs, filtered to SalesWorkflowItemStatusId.Title
//                             === "Requisitions Open" and ClosedOn === null)
//   - Placements in the      (/api3/placements, filtered to StartDate inside the
//     program window          scorecard channel's programStartMonth + programHorizon)
//   - New placements         (any /api3/placements row not yet in the cache —
//                             on first-see we post a system message to the
//                             scorecard channel and push notify every member)
//
// Trigger note: Crelate does not expose candidate workflow-stage transitions
// through /api3 (stages live only in the recruiter UI). The best available
// offer-signed signal is a new placement record, which in Crelate's model
// is only created when an offer is accepted. This is documented in the PR
// body and the smoke test.
//
// The poller is idempotent — every read is upsert-by-Crelate-Id and
// notifications gate on notified_at being null in crelate_placements_cache.
//
// Auth: reads process.env.CRELATE_API_KEY and appends it as ?api_key=... on
// every request. Crelate's API3 accepts the key as either a query param or
// an Authorization header — we use the query param to match Crelate's own
// documented examples. If CRELATE_API_KEY is missing we skip polling and
// log once at boot; the scorecard client hides the tiles when the cache
// stays empty.
//
// This module is deliberately dependency-light: no better-sqlite3 direct
// import (it reads rawDb from db.ts), no Drizzle for the two cache tables
// (they're append/upsert-heavy and the shape is likely to churn as we tune
// the scoreboard — Drizzle migrations add friction we don't need here).

import { rawDb } from "./db";
import { storage } from "./storage";
import { sendExpoNotificationToUsers } from "./expo-push";
import { emitMessageNew } from "./events";
import { buildWireMessage } from "./routes";

// System user for authoring background-posted messages. Matches the same
// SYSTEM_USER_ID = 1 convention used by the internal clear-channel tombstone
// path in routes.ts.
const SYSTEM_USER_ID = 1;

// ─── Config ──────────────────────────────────────────────────────────────

const CRELATE_API_BASE = "https://app.crelate.com/api3";
const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const FETCH_TIMEOUT_MS = 20 * 1000; // 20 seconds
const JOBS_PAGE_TAKE = 500;
const PLACEMENTS_PAGE_TAKE = 200;
const SCORECARD_CHANNEL_NAME = "vts-recruiter-scorecard";

// ─── Crelate response types (partial) ────────────────────────────────────

// Only the fields we actually consume. Crelate returns 100+ keys per row.
interface CrelateJob {
  Id: string;
  Title?: string;
  PortalTitle?: string | null;
  ClosedOn?: string | null;
  IsOnHold?: boolean | null;
  NumberOfOpenings?: number | null;
  NumberOfPlacements?: number | null;
  SalesWorkflowItemStatusId?: { Id: string; Title: string } | null;
  AccountId?: { Id: string; Title: string } | null;
  JobTitleId?: { Id: string; Title: string } | null;
  UserOpenDate?: string | null;
  ModifiedOn?: string | null;
}

interface CrelatePlacement {
  Id: string;
  Name?: string | null;
  PlacedContactId?: { Id: string; Title: string } | null;
  AccountId?: { Id: string; Title: string } | null;
  JobTitleId?: { Id: string; Title: string } | null;
  StartDate?: string | null;
  CreatedOn?: string | null;
  ModifiedOn?: string | null;
  EntityStatus?: number | null;
  StatusReason?: string | null;
  PlacementNum?: number | null;
  RegardingId?: { Id: string; Title: string } | null;
}

interface CrelateListResponse<T> {
  Data: T[];
  Metadata?: { CorrelationId?: string; TimeStamp?: string };
  Errors?: unknown[];
}

// ─── Cache types (what the scorecard GET reads) ──────────────────────────

export interface OpenReqRow {
  jobId: string;
  title: string;
  account: string | null;
  openings: number;
  filled: number;
  status: string;
  crelateUrl: string;
  updatedAt: number;
}

export interface HireRow {
  placementId: string;
  placedContactName: string | null;
  jobTitle: string | null;
  accountName: string | null;
  startDate: string | null;
  createdOn: string | null;
  crelateUrl: string;
}

// ─── HTTP helper with timeout + error swallow ────────────────────────────

async function fetchCrelate<T>(path: string): Promise<T | null> {
  const apiKey = process.env.CRELATE_API_KEY;
  if (!apiKey) {
    // Guarded once at boot too, but keep a defensive log here so
    // production misconfig is loud, not silent.
    console.warn(`[crelate-poller] ${path} skipped: CRELATE_API_KEY not set`);
    return null;
  }
  // Build the URL without ever letting the key hit an error log line. We
  // separate `path` (safe to log) from the auth-bearing URL. On 4xx/5xx
  // we log only the path and status code — never the full URL, never the
  // response body (Crelate echoes the api_key in 404 Metadata.Url).
  const sep = path.includes("?") ? "&" : "?";
  const url = `${CRELATE_API_BASE}${path}${sep}api_key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.warn(`[crelate-poller] ${path} HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn(`[crelate-poller] ${path} timeout`);
    } else {
      // Scrub the message defensively in case a rare network stack
      // surfaces the URL in the exception text.
      const raw = String(err?.message ?? err);
      const scrubbed = raw.replace(/api_key=[^&\s"]+/gi, "api_key=***");
      console.warn(`[crelate-poller] ${path} error: ${scrubbed}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Scorecard channel discovery ─────────────────────────────────────────

// We support one scorecard channel per Bulldogchat project. Multi-project
// deploys can each have their own #vts-recruiter-scorecard; the poller
// runs per-channel and per-project's config drives its own program window.
function findScorecardChannels(): Array<{
  channelId: number;
  orgId: number;
  projectId: number;
  programStartMonth: string;
  programHorizonMonths: number;
}> {
  const rows = rawDb
    .prepare(
      `SELECT c.id AS channelId, p.org_id AS orgId, c.project_id AS projectId,
              cfg.config_json AS configJson
         FROM channels c
         JOIN projects p ON p.id = c.project_id
         LEFT JOIN channel_scorecard_configs cfg ON cfg.channel_id = c.id
         WHERE c.name = ? AND c.type = 'scorecard'`,
    )
    .all(SCORECARD_CHANNEL_NAME) as Array<{
    channelId: number;
    orgId: number;
    projectId: number;
    configJson: string | null;
  }>;
  return rows.map((r) => {
    let programStartMonth = "2026-08";
    let programHorizonMonths = 5;
    if (r.configJson) {
      try {
        const cfg = JSON.parse(r.configJson);
        if (typeof cfg?.programStartMonth === "string")
          programStartMonth = cfg.programStartMonth;
        if (typeof cfg?.programHorizonMonths === "number")
          programHorizonMonths = cfg.programHorizonMonths;
      } catch {
        // fall back to defaults
      }
    }
    return {
      channelId: r.channelId,
      orgId: r.orgId,
      projectId: r.projectId,
      programStartMonth,
      programHorizonMonths,
    };
  });
}

// ─── Program window math ─────────────────────────────────────────────────

// Returns [inclusive start ISO, exclusive end ISO] for a program window
// like ("2026-08", 5) → ["2026-08-01T00:00:00Z", "2027-01-01T00:00:00Z"].
function programWindowIsoBounds(
  programStartMonth: string,
  programHorizonMonths: number,
): [string, string] {
  const [yy, mm] = programStartMonth.split("-").map((s) => parseInt(s, 10));
  const start = new Date(Date.UTC(yy, mm - 1, 1));
  const end = new Date(Date.UTC(yy, mm - 1 + programHorizonMonths, 1));
  return [start.toISOString(), end.toISOString()];
}

// ─── Poll: open reqs ─────────────────────────────────────────────────────

async function pollOpenReqs(channelId: number): Promise<number> {
  const payload = await fetchCrelate<CrelateListResponse<CrelateJob>>(
    `/jobs?take=${JOBS_PAGE_TAKE}`,
  );
  if (!payload?.Data) return 0;

  const now = Date.now();
  const openReqs = payload.Data.filter((j) => {
    const status = j.SalesWorkflowItemStatusId?.Title ?? "";
    return status === "Requisitions Open" && !j.ClosedOn;
  });

  // Wipe cache for this channel and rewrite. Small dataset (< a few hundred
  // rows), and we want the cache to reflect the exact current API view —
  // reqs that dropped off Crelate should stop showing on the scoreboard.
  const clear = rawDb.prepare(`DELETE FROM crelate_open_reqs_cache WHERE channel_id = ?`);
  const insert = rawDb.prepare(
    `INSERT INTO crelate_open_reqs_cache
       (channel_id, job_id, portal_title, account_name, openings, filled,
        workflow_status, crelate_url, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = rawDb.transaction((rows: CrelateJob[]) => {
    clear.run(channelId);
    for (const j of rows) {
      insert.run(
        channelId,
        j.Id,
        j.PortalTitle ?? j.JobTitleId?.Title ?? j.Title ?? "(untitled)",
        j.AccountId?.Title ?? null,
        j.NumberOfOpenings ?? 0,
        j.NumberOfPlacements ?? 0,
        j.SalesWorkflowItemStatusId?.Title ?? "Requisitions Open",
        `https://app.crelate.com/jobs/${j.Id}`,
        now,
      );
    }
  });
  tx(openReqs);
  return openReqs.length;
}

// ─── Poll: placements (window hires + new-placement notifications) ───────

async function pollPlacements(opts: {
  channelId: number;
  orgId: number;
  programStartMonth: string;
  programHorizonMonths: number;
}): Promise<{ hiresInWindow: number; newPlacements: number }> {
  const payload = await fetchCrelate<CrelateListResponse<CrelatePlacement>>(
    `/placements?take=${PLACEMENTS_PAGE_TAKE}`,
  );
  if (!payload?.Data) return { hiresInWindow: 0, newPlacements: 0 };

  const [winStart, winEnd] = programWindowIsoBounds(
    opts.programStartMonth,
    opts.programHorizonMonths,
  );
  const now = Date.now();
  let newPlacements = 0;
  let hiresInWindow = 0;

  const upsert = rawDb.prepare(
    `INSERT INTO crelate_placements_cache
       (placement_id, channel_id, placed_contact_name, job_title, account_name,
        start_date, created_on, entity_status, status_reason, crelate_url,
        in_program_window, first_seen_at, notified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(placement_id, channel_id) DO UPDATE SET
       placed_contact_name = excluded.placed_contact_name,
       job_title = excluded.job_title,
       account_name = excluded.account_name,
       start_date = excluded.start_date,
       entity_status = excluded.entity_status,
       status_reason = excluded.status_reason,
       in_program_window = excluded.in_program_window`,
  );

  const selectExisting = rawDb.prepare(
    `SELECT placement_id AS placementId, notified_at AS notifiedAt
       FROM crelate_placements_cache
       WHERE placement_id = ? AND channel_id = ?`,
  );

  // Two-pass: first, upsert every placement + count hires-in-window. Second,
  // for placements we've never seen before, fire the toast + push.
  const brandNew: CrelatePlacement[] = [];

  const tx = rawDb.transaction((rows: CrelatePlacement[]) => {
    for (const p of rows) {
      const inWindow =
        !!p.StartDate && p.StartDate >= winStart && p.StartDate < winEnd ? 1 : 0;
      if (inWindow) hiresInWindow += 1;

      const existing = selectExisting.get(p.Id, opts.channelId) as
        | { placementId: string; notifiedAt: number | null }
        | undefined;
      if (!existing) {
        brandNew.push(p);
      }

      upsert.run(
        p.Id,
        opts.channelId,
        p.PlacedContactId?.Title ?? null,
        p.JobTitleId?.Title ?? p.RegardingId?.Title ?? null,
        p.AccountId?.Title ?? null,
        p.StartDate ?? null,
        p.CreatedOn ?? null,
        p.EntityStatus ?? null,
        p.StatusReason ?? null,
        `https://app.crelate.com/placements/${p.Id}`,
        inWindow,
        now,
      );
    }
  });
  tx(payload.Data);

  // Notify per brand-new placement. On startup, this floods — we suppress
  // notifications for the very first poll cycle (see initialize()).
  for (const p of brandNew) {
    try {
      await notifyNewPlacement({
        channelId: opts.channelId,
        orgId: opts.orgId,
        placement: p,
      });
      rawDb
        .prepare(
          `UPDATE crelate_placements_cache SET notified_at = ?
             WHERE placement_id = ? AND channel_id = ?`,
        )
        .run(Date.now(), p.Id, opts.channelId);
      newPlacements += 1;
    } catch (err: any) {
      console.warn(
        `[crelate-poller] notify failed for placement ${p.Id}: ${err?.message ?? err}`,
      );
    }
  }

  return { hiresInWindow, newPlacements };
}

// ─── Post system message + push notify ───────────────────────────────────

async function notifyNewPlacement(opts: {
  channelId: number;
  orgId: number;
  placement: CrelatePlacement;
}): Promise<void> {
  const p = opts.placement;
  const contact = p.PlacedContactId?.Title ?? "Unknown candidate";
  const jobTitle = p.JobTitleId?.Title ?? p.RegardingId?.Title ?? "role";
  const account = p.AccountId?.Title ?? null;
  const startDateStr = p.StartDate
    ? new Date(p.StartDate).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "TBD";

  const headline = `Offer signed — ${contact}`;
  const detail = account
    ? `${jobTitle} at ${account}. Start ${startDateStr}.`
    : `${jobTitle}. Start ${startDateStr}.`;
  const crelateUrl = `https://app.crelate.com/placements/${p.Id}`;

  // 1. System chat message so the event is visible in-line + archived.
  const meta = JSON.stringify({
    kind: "crelate.new_placement",
    placementId: p.Id,
    contact,
    jobTitle,
    account,
    startDate: p.StartDate,
    crelateUrl,
  });
  try {
    // storage.createMessage takes a system-message shape; the client's
    // ScorecardChannelView subscribes to messages with meta.kind starting
    // with "crelate." and renders a card + fires a toast.
    const msg = storage.createMessage({
      channelId: opts.channelId,
      userId: SYSTEM_USER_ID,
      content: `${headline} — ${detail}`,
      meta,
    });
    const wire = buildWireMessage((msg as any).id);
    if (wire) emitMessageNew(opts.orgId, wire);
  } catch (err: any) {
    console.warn(
      `[crelate-poller] createMessage failed: ${err?.message ?? err}`,
    );
  }

  // 2. Push to every member of the scorecard channel.
  try {
    const memberIds = storage.listChannelMemberIds(opts.channelId);
    if (memberIds.length > 0) {
      await sendExpoNotificationToUsers(memberIds, {
        title: headline,
        body: detail,
        url: crelateUrl,
        data: {
          kind: "crelate.new_placement",
          placementId: p.Id,
          channelId: opts.channelId,
        },
      });
    }
  } catch (err: any) {
    console.warn(
      `[crelate-poller] push failed: ${err?.message ?? err}`,
    );
  }
}

// ─── Public: single-tick poller (used by both interval + manual trigger) ─

export async function pollOnce(opts?: {
  suppressNotifications?: boolean;
}): Promise<{
  channelsPolled: number;
  openReqsTotal: number;
  hiresInWindowTotal: number;
  newPlacementsTotal: number;
}> {
  const channels = findScorecardChannels();
  let openReqsTotal = 0;
  let hiresInWindowTotal = 0;
  let newPlacementsTotal = 0;

  for (const ch of channels) {
    try {
      const openCount = await pollOpenReqs(ch.channelId);
      openReqsTotal += openCount;

      if (opts?.suppressNotifications) {
        // Seed pass — mark everything as already-notified so we don't flood
        // on the very first run after deploy.
        const seedRes = await pollPlacements(ch);
        hiresInWindowTotal += seedRes.hiresInWindow;
        // Wipe out any notified_at=null that just got created.
        rawDb
          .prepare(
            `UPDATE crelate_placements_cache
               SET notified_at = ?
               WHERE channel_id = ? AND notified_at IS NULL`,
          )
          .run(Date.now(), ch.channelId);
      } else {
        const res = await pollPlacements(ch);
        hiresInWindowTotal += res.hiresInWindow;
        newPlacementsTotal += res.newPlacements;
      }
    } catch (err: any) {
      console.warn(
        `[crelate-poller] channel ${ch.channelId} failed: ${err?.message ?? err}`,
      );
    }
  }

  return {
    channelsPolled: channels.length,
    openReqsTotal,
    hiresInWindowTotal,
    newPlacementsTotal,
  };
}

// ─── Public: read helpers for the scorecard GET endpoint ─────────────────

export function readOpenReqs(channelId: number): OpenReqRow[] {
  const rows = rawDb
    .prepare(
      `SELECT job_id AS jobId, portal_title AS title, account_name AS account,
              openings, filled, workflow_status AS status,
              crelate_url AS crelateUrl, updated_at AS updatedAt
         FROM crelate_open_reqs_cache
         WHERE channel_id = ?
         ORDER BY account_name ASC, portal_title ASC`,
    )
    .all(channelId) as OpenReqRow[];
  return rows;
}

export function readHiresInWindow(channelId: number): HireRow[] {
  const rows = rawDb
    .prepare(
      `SELECT placement_id AS placementId, placed_contact_name AS placedContactName,
              job_title AS jobTitle, account_name AS accountName,
              start_date AS startDate, created_on AS createdOn,
              crelate_url AS crelateUrl
         FROM crelate_placements_cache
         WHERE channel_id = ? AND in_program_window = 1
         ORDER BY start_date DESC`,
    )
    .all(channelId) as HireRow[];
  return rows;
}

export function readLatestPlacements(
  channelId: number,
  limit = 10,
): HireRow[] {
  const rows = rawDb
    .prepare(
      `SELECT placement_id AS placementId, placed_contact_name AS placedContactName,
              job_title AS jobTitle, account_name AS accountName,
              start_date AS startDate, created_on AS createdOn,
              crelate_url AS crelateUrl
         FROM crelate_placements_cache
         WHERE channel_id = ?
         ORDER BY COALESCE(created_on, '') DESC
         LIMIT ?`,
    )
    .all(channelId, limit) as HireRow[];
  return rows;
}

// ─── Public: initialize (call from server/index.ts on boot) ──────────────

let _timer: NodeJS.Timeout | null = null;

export function initializeCrelatePoller(): void {
  // Skip entirely when the credential isn't wired. This lets local dev
  // work without adding Crelate to every developer's env.
  //
  // We probe by making a single request through the proxy; the proxy will
  // 401 or the credential lookup will noop. We treat that as "disabled."
  const enabled = process.env.CRELATE_POLLER_ENABLED !== "0";
  if (!enabled) {
    console.log("[crelate-poller] disabled via CRELATE_POLLER_ENABLED=0");
    return;
  }
  if (!process.env.CRELATE_API_KEY) {
    console.warn(
      "[crelate-poller] CRELATE_API_KEY not set \u2014 poller idle. Scorecard tiles will read zeros until the env var is added.",
    );
    return;
  }

  // Seed pass — populate caches without firing 100 push notifications for
  // every existing placement in Crelate.
  pollOnce({ suppressNotifications: true })
    .then((r) =>
      console.log(
        `[crelate-poller] seed complete: channels=${r.channelsPolled} openReqs=${r.openReqsTotal} hires=${r.hiresInWindowTotal}`,
      ),
    )
    .catch((err) =>
      console.warn(`[crelate-poller] seed failed: ${err?.message ?? err}`),
    );

  // Recurring polls. Any un-notified placements after the seed will fire
  // notifications on the next tick, which is exactly what we want — that's
  // how a real signed offer surfaces post-deploy.
  _timer = setInterval(() => {
    pollOnce()
      .then((r) => {
        if (r.newPlacementsTotal > 0) {
          console.log(
            `[crelate-poller] tick: new placements=${r.newPlacementsTotal} openReqs=${r.openReqsTotal} hires=${r.hiresInWindowTotal}`,
          );
        }
      })
      .catch((err) =>
        console.warn(`[crelate-poller] tick failed: ${err?.message ?? err}`),
      );
  }, POLL_INTERVAL_MS);

  console.log(
    `[crelate-poller] initialized — interval ${POLL_INTERVAL_MS / 1000}s`,
  );
}

// For tests + graceful shutdown.
export function stopCrelatePoller(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
