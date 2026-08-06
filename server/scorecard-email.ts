/**
 * scorecard-email.ts — renders a scorecard channel snapshot into a
 * text + HTML email body.
 *
 * Kept intentionally standalone (no DOM, no React) so the render is
 * driven purely by the server's authoritative view of the config +
 * actuals rows. The math mirrors the client's `computeTargets` +
 * `fractionOfProgramElapsed` helpers in ScorecardChannelView.tsx —
 * two horizons (funding sizes total, program sizes cadence) plus a
 * fixed forward program window (default Aug→Dec 2026 for VTS).
 *
 * If the two files drift, the client remains the source of truth for
 * on-screen numbers and this file is what recipients see. Keep the
 * formulas in sync whenever computeTargets moves.
 */

const DEFAULT_PROGRAM_START_MONTH = "2026-08";
const DEFAULT_PROGRAM_HORIZON_MONTHS = 5;
const DEFAULT_FUNDING_HORIZON_MONTHS = 6;

export interface ScorecardConfigForEmail {
  averageFee: number; // dollars
  profitTarget: number; // 0..1
  stretchMultiplier: number; // e.g. 1.25
  recruiters: Array<{ key: string; name: string; monthlySalary?: number }>;
  thresholds: { green: number; yellow: number };
  programStartMonth?: string; // "YYYY-MM"
  programHorizonMonths?: number;
  fundingHorizonMonths?: number;
}

export interface ActualRow {
  recruiterKey: string;
  periodMonth: string; // "YYYY-MM"
  placementsCount: number;
  feeAmountCents: number;
}

// ---------- money / percent formatting ----------

const fmtUSD = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Math.round(n));

const fmtPct = (n: number) => `${Math.round(n * 100)}%`;

// ---------- pace math (mirror of client helpers) ----------

/** Fraction of the forward program window that has elapsed, clamped 0..1. */
export function fractionOfProgramElapsed(
  startMonth: string,
  horizonMonths: number,
  now: Date = new Date(),
): number {
  const m = /^(\d{4})-(\d{2})$/.exec(startMonth);
  if (!m) return 0;
  const startY = Number(m[1]);
  const startMo = Number(m[2]) - 1;
  const start = new Date(Date.UTC(startY, startMo, 1));
  const totalMs = horizonMonths * 30.4375 * 24 * 3600 * 1000;
  const elapsedMs = now.getTime() - start.getTime();
  return Math.max(0, Math.min(1, elapsedMs / totalMs));
}

interface Targets {
  fundingHorizonMonths: number;
  programHorizonMonths: number;
  teamTotalRevenue: number;
  teamMonthlyRevenue: number;
  teamFloorPlacements: number;
  perRecruiter: Array<{
    key: string;
    name: string;
    monthlySalary: number | null;
    totalRevenue: number;
    monthlyRevenue: number;
  }>;
}

/**
 * total   = totalMonthlySalary × fundingHorizon / (1 − profit)
 * monthly = total / programHorizon
 * floor   = round(total / averageFee)
 *
 * When funding == program, this collapses to pro-rata behavior.
 */
export function computeTargets(cfg: ScorecardConfigForEmail): Targets {
  const denom = Math.max(0.01, 1 - cfg.profitTarget);
  const F = cfg.fundingHorizonMonths ?? DEFAULT_FUNDING_HORIZON_MONTHS;
  const P = cfg.programHorizonMonths ?? DEFAULT_PROGRAM_HORIZON_MONTHS;
  const totalMonthlySalary = cfg.recruiters.reduce(
    (s, r) => s + (r.monthlySalary ?? 0),
    0,
  );
  const teamTotalRevenue = (totalMonthlySalary * F) / denom;
  const teamMonthlyRevenue = teamTotalRevenue / P;
  const teamFloorPlacements = Math.round(
    teamTotalRevenue / Math.max(1, cfg.averageFee),
  );
  const perRecruiter = cfg.recruiters.map((r) => {
    const monthlySalary = r.monthlySalary ?? null;
    const totalRevenue =
      monthlySalary != null
        ? (monthlySalary * F) / denom
        : teamTotalRevenue / cfg.recruiters.length;
    return {
      key: r.key,
      name: r.name,
      monthlySalary,
      totalRevenue,
      monthlyRevenue: totalRevenue / P,
    };
  });
  return {
    fundingHorizonMonths: F,
    programHorizonMonths: P,
    teamTotalRevenue,
    teamMonthlyRevenue,
    teamFloorPlacements,
    perRecruiter,
  };
}

// ---------- actuals aggregation ----------

interface ActualsAgg {
  perRecruiter: Record<
    string,
    { totalPlacements: number; totalRevenue: number; mtdPlacements: number; mtdRevenue: number }
  >;
  teamTotalPlacements: number;
  teamTotalRevenue: number;
  teamMtdPlacements: number;
  teamMtdRevenue: number;
}

function currentMonthKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Sum actuals across the fixed program window only. Rows outside
 * [programStart, programStart+P) are ignored so the email lines up
 * with the on-screen totals (which also clip to the window).
 */
export function aggregateActuals(
  cfg: ScorecardConfigForEmail,
  actuals: ActualRow[],
  now: Date = new Date(),
): ActualsAgg {
  const start = cfg.programStartMonth ?? DEFAULT_PROGRAM_START_MONTH;
  const horizon = cfg.programHorizonMonths ?? DEFAULT_PROGRAM_HORIZON_MONTHS;
  const m = /^(\d{4})-(\d{2})$/.exec(start);
  const inWindow = (periodMonth: string): boolean => {
    if (!m) return true;
    const pm = /^(\d{4})-(\d{2})$/.exec(periodMonth);
    if (!pm) return false;
    const startIdx = Number(m[1]) * 12 + (Number(m[2]) - 1);
    const rowIdx = Number(pm[1]) * 12 + (Number(pm[2]) - 1);
    return rowIdx >= startIdx && rowIdx < startIdx + horizon;
  };
  const thisMonth = currentMonthKey(now);
  const agg: ActualsAgg = {
    perRecruiter: {},
    teamTotalPlacements: 0,
    teamTotalRevenue: 0,
    teamMtdPlacements: 0,
    teamMtdRevenue: 0,
  };
  for (const r of cfg.recruiters) {
    agg.perRecruiter[r.key] = {
      totalPlacements: 0,
      totalRevenue: 0,
      mtdPlacements: 0,
      mtdRevenue: 0,
    };
  }
  for (const row of actuals) {
    if (!inWindow(row.periodMonth)) continue;
    const bucket = agg.perRecruiter[row.recruiterKey];
    if (!bucket) continue; // stale recruiter no longer in config
    const revenue = row.feeAmountCents / 100;
    bucket.totalPlacements += row.placementsCount;
    bucket.totalRevenue += revenue;
    agg.teamTotalPlacements += row.placementsCount;
    agg.teamTotalRevenue += revenue;
    if (row.periodMonth === thisMonth) {
      bucket.mtdPlacements += row.placementsCount;
      bucket.mtdRevenue += revenue;
      agg.teamMtdPlacements += row.placementsCount;
      agg.teamMtdRevenue += revenue;
    }
  }
  return agg;
}

// ---------- HTML + text renderers ----------

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function paceLabel(actual: number, expected: number): string {
  if (expected <= 0) return "n/a";
  const pct = actual / expected;
  return fmtPct(pct);
}

export interface RenderInput {
  channelName: string;
  channelTopic?: string | null;
  senderName?: string | null;
  note?: string | null;
  config: ScorecardConfigForEmail;
  actuals: ActualRow[];
  updatedAt?: number | null;
  now?: Date;
}

export interface RenderedEmail {
  text: string;
  html: string;
}

export function renderScorecardEmail(input: RenderInput): RenderedEmail {
  const now = input.now ?? new Date();
  const cfg = input.config;
  const t = computeTargets(cfg);
  const a = aggregateActuals(cfg, input.actuals, now);
  const start = cfg.programStartMonth ?? DEFAULT_PROGRAM_START_MONTH;
  const frac = fractionOfProgramElapsed(start, t.programHorizonMonths, now);
  const expectedTeamRevenueToDate = t.teamTotalRevenue * frac;
  const twoHorizon = t.fundingHorizonMonths !== t.programHorizonMonths;

  // -------- plain-text body --------

  const textLines: string[] = [];
  textLines.push(`${input.channelName} — scorecard snapshot`);
  if (input.channelTopic) textLines.push(input.channelTopic);
  textLines.push("");
  if (input.note && input.note.trim().length > 0) {
    textLines.push(input.note.trim());
    textLines.push("");
  }
  textLines.push(
    `Program: ${start} for ${t.programHorizonMonths} months ` +
      `(${Math.round(frac * 100)}% elapsed)`,
  );
  if (twoHorizon) {
    textLines.push(
      `Underwriting horizon: ${t.fundingHorizonMonths} months — total goal delivered in ${t.programHorizonMonths} months of cadence.`,
    );
  }
  textLines.push("");
  textLines.push("TEAM");
  textLines.push(
    `  Revenue target       ${fmtUSD(t.teamTotalRevenue)}  ` +
      (twoHorizon
        ? `(${t.fundingHorizonMonths}-mo goal · ${t.programHorizonMonths}-mo cadence)`
        : `(${t.programHorizonMonths} months)`),
  );
  textLines.push(`  Monthly target       ${fmtUSD(t.teamMonthlyRevenue)}`);
  textLines.push(
    `  Floor placements     ${t.teamFloorPlacements} at ${fmtUSD(cfg.averageFee)} avg fee`,
  );
  textLines.push(
    `  Actuals to date      ${fmtUSD(a.teamTotalRevenue)} (${a.teamTotalPlacements} placements)`,
  );
  textLines.push(
    `  Expected to date     ${fmtUSD(expectedTeamRevenueToDate)}  ` +
      `→ pace ${paceLabel(a.teamTotalRevenue, expectedTeamRevenueToDate)}`,
  );
  textLines.push(
    `  Month-to-date        ${fmtUSD(a.teamMtdRevenue)} (${a.teamMtdPlacements} placements)`,
  );
  textLines.push("");
  textLines.push("RECRUITERS");
  for (const r of t.perRecruiter) {
    const rowActuals = a.perRecruiter[r.key] ?? {
      totalPlacements: 0,
      totalRevenue: 0,
      mtdPlacements: 0,
      mtdRevenue: 0,
    };
    const expectedR = r.totalRevenue * frac;
    textLines.push(
      `  ${r.name.padEnd(24).slice(0, 24)} ` +
        `goal ${fmtUSD(r.totalRevenue).padStart(10)}  ` +
        `actual ${fmtUSD(rowActuals.totalRevenue).padStart(10)}  ` +
        `pace ${paceLabel(rowActuals.totalRevenue, expectedR).padStart(4)}  ` +
        `MTD ${fmtUSD(rowActuals.mtdRevenue).padStart(9)} (${rowActuals.mtdPlacements})`,
    );
  }
  textLines.push("");
  textLines.push(
    `Sent from Bulldog Chat · scorecard channel #${esc(input.channelName)}`,
  );
  if (input.senderName) textLines.push(`Sent by ${input.senderName}`);
  const text = textLines.join("\n");

  // -------- HTML body --------

  const paceBadge = (actual: number, expected: number): string => {
    if (expected <= 0) {
      return `<span style="color:#64748b">n/a</span>`;
    }
    const pct = actual / expected;
    const green = cfg.thresholds?.green ?? 0.9;
    const yellow = cfg.thresholds?.yellow ?? 0.7;
    const color =
      pct >= green ? "#16a34a" : pct >= yellow ? "#ca8a04" : "#dc2626";
    return `<span style="color:${color};font-weight:600">${fmtPct(pct)}</span>`;
  };

  const rowHtml = t.perRecruiter
    .map((r) => {
      const rowActuals = a.perRecruiter[r.key] ?? {
        totalPlacements: 0,
        totalRevenue: 0,
        mtdPlacements: 0,
        mtdRevenue: 0,
      };
      const expectedR = r.totalRevenue * frac;
      return `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb">${esc(r.name)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums">${fmtUSD(r.totalRevenue)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums">${fmtUSD(rowActuals.totalRevenue)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${paceBadge(rowActuals.totalRevenue, expectedR)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums">${fmtUSD(rowActuals.mtdRevenue)}<span style="color:#64748b;font-size:11px"> · ${rowActuals.mtdPlacements}</span></td>
      </tr>`;
    })
    .join("");

  const noteBlock =
    input.note && input.note.trim().length > 0
      ? `<div style="background:#f1f5f9;border-left:3px solid #0090F0;padding:12px 14px;margin:16px 0;border-radius:4px;white-space:pre-wrap">${esc(input.note.trim())}</div>`
      : "";

  const horizonNote = twoHorizon
    ? `<div style="color:#475569;font-size:12px;margin-top:4px">
        <strong>${t.fundingHorizonMonths}-mo underwritten goal</strong> delivered in a
        <strong>${t.programHorizonMonths}-mo</strong> program window — monthly cadence scaled to hit the full total.
      </div>`
    : "";

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a">
  <div style="max-width:640px;margin:0 auto;padding:24px">
    <div style="background:linear-gradient(135deg,#0090F0,#0064B8);color:#fff;border-radius:12px;padding:20px 22px">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;opacity:0.85">Scorecard</div>
      <div style="font-size:22px;font-weight:600;margin-top:2px">${esc(input.channelName)}</div>
      ${input.channelTopic ? `<div style="font-size:13px;opacity:0.9;margin-top:2px">${esc(input.channelTopic)}</div>` : ""}
      <div style="font-size:12px;opacity:0.9;margin-top:10px">
        Program: <strong>${esc(start)}</strong> for <strong>${t.programHorizonMonths} months</strong>
        · <strong>${Math.round(frac * 100)}%</strong> elapsed
      </div>
      ${horizonNote}
    </div>

    ${noteBlock}

    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px 20px;margin-top:16px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#64748b;font-weight:600">Team</div>
      <table style="width:100%;margin-top:10px;border-collapse:collapse">
        <tr>
          <td style="padding:6px 0;color:#475569">Revenue target</td>
          <td style="padding:6px 0;text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${fmtUSD(t.teamTotalRevenue)}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#475569">Monthly team target</td>
          <td style="padding:6px 0;text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${fmtUSD(t.teamMonthlyRevenue)}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#475569">Floor placements</td>
          <td style="padding:6px 0;text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${t.teamFloorPlacements} <span style="color:#64748b;font-weight:400;font-size:12px">at ${fmtUSD(cfg.averageFee)} avg fee</span></td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#475569;border-top:1px solid #e5e7eb">Actuals to date</td>
          <td style="padding:6px 0;text-align:right;font-variant-numeric:tabular-nums;border-top:1px solid #e5e7eb">${fmtUSD(a.teamTotalRevenue)} <span style="color:#64748b;font-size:12px"> · ${a.teamTotalPlacements} placements</span></td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#475569">Expected to date</td>
          <td style="padding:6px 0;text-align:right;font-variant-numeric:tabular-nums">${fmtUSD(expectedTeamRevenueToDate)} <span style="font-size:12px"> · pace ${paceBadge(a.teamTotalRevenue, expectedTeamRevenueToDate)}</span></td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#475569">Month-to-date</td>
          <td style="padding:6px 0;text-align:right;font-variant-numeric:tabular-nums">${fmtUSD(a.teamMtdRevenue)} <span style="color:#64748b;font-size:12px"> · ${a.teamMtdPlacements} placements</span></td>
        </tr>
      </table>
    </div>

    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:0;margin-top:16px;overflow:hidden">
      <div style="padding:14px 20px 6px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#64748b;font-weight:600">Recruiters</div>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#f8fafc;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:0.5px">
            <th style="text-align:left;padding:8px 10px;font-weight:600">Name</th>
            <th style="text-align:right;padding:8px 10px;font-weight:600">Goal</th>
            <th style="text-align:right;padding:8px 10px;font-weight:600">Actual</th>
            <th style="text-align:right;padding:8px 10px;font-weight:600">Pace</th>
            <th style="text-align:right;padding:8px 10px;font-weight:600">MTD</th>
          </tr>
        </thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </div>

    <div style="color:#94a3b8;font-size:12px;margin-top:20px;text-align:center">
      Sent from Bulldog Chat · scorecard channel #${esc(input.channelName)}${input.senderName ? ` · by ${esc(input.senderName)}` : ""}
    </div>
  </div>
</body>
</html>`;

  return { text, html };
}
