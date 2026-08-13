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

// Mirrors the client's fractionOfCurrentMonthElapsed helper so the
// email's per-recruiter MTD pace matches the dashboard tile 1:1. Uses
// UTC math because the actuals aggregator also runs in UTC — keeping
// both on the same clock avoids off-by-one at midnight boundaries.
function fractionOfCurrentMonthElapsed(now: Date = new Date()): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = Date.UTC(y, m, 1);
  const end = Date.UTC(y, m + 1, 1);
  const elapsed = now.getTime() - start;
  return Math.max(0, Math.min(1, elapsed / (end - start)));
}

// Full-day count remaining in the current month, treating today as still
// workable (matches client card math so "$/day to close" reads the same).
function daysLeftInMonth(now: Date = new Date()): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Math.max(1, daysInMonth - now.getUTCDate() + 1);
}

// Days remaining in the fixed forward program window
// [programStartMonth, programStartMonth + horizonMonths). Clamped to a
// minimum of 1 so a program-ended edge case still renders a legit
// "$X/day" number instead of divide-by-zero.
function daysLeftInProgram(
  startMonth: string,
  horizonMonths: number,
  now: Date = new Date(),
): number {
  const mm = /^(\d{4})-(\d{2})$/.exec(startMonth);
  if (!mm) return 1;
  const endMs = Date.UTC(
    Number(mm[1]),
    Number(mm[2]) - 1 + horizonMonths,
    1,
  );
  const msLeft = endMs - now.getTime();
  return Math.max(1, Math.ceil(msLeft / 86_400_000));
}

// Small helper for the recruiter card action line so both text and HTML
// paths render the exact same wording.
function perDayAction(
  actual: number,
  goal: number,
  daysLeft: number,
  suffix: string,
): string {
  const remaining = Math.max(0, goal - actual);
  if (remaining === 0 && goal > 0) return "Goal met";
  if (goal <= 0 || daysLeft <= 0) return "";
  const perDay = Math.round(remaining / daysLeft);
  return `${fmtUSD(perDay)}/day ${suffix}`;
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

  // Precomputed once and reused by BOTH the text and HTML renderers so
  // the two paths can never drift. Every row carries the same shape the
  // dashboard's hero tiles use: monthly + program actual/goal/pace and a
  // ready-to-render action line.
  const mtdFrac = fractionOfCurrentMonthElapsed(now);
  const dLeftMonth = daysLeftInMonth(now);
  const dLeftProgram = daysLeftInProgram(start, t.programHorizonMonths, now);
  const recruiterCards = t.perRecruiter.map((r) => {
    const rowActuals = a.perRecruiter[r.key] ?? {
      totalPlacements: 0,
      totalRevenue: 0,
      mtdPlacements: 0,
      mtdRevenue: 0,
    };
    const monthlyExpected = r.monthlyRevenue * mtdFrac;
    const programExpected = r.totalRevenue * frac;
    return {
      key: r.key,
      name: r.name,
      monthlyGoal: r.monthlyRevenue,
      programGoal: r.totalRevenue,
      mtdActual: rowActuals.mtdRevenue,
      mtdPlacements: rowActuals.mtdPlacements,
      programActual: rowActuals.totalRevenue,
      programPlacements: rowActuals.totalPlacements,
      monthlyExpected,
      programExpected,
      // Pace label uses the same green/yellow/red thresholds the client
      // uses (via paceBadge below on the HTML side).
      mtdAction: perDayAction(
        rowActuals.mtdRevenue,
        r.monthlyRevenue,
        dLeftMonth,
        "to close",
      ),
      programAction: perDayAction(
        rowActuals.totalRevenue,
        r.totalRevenue,
        dLeftProgram,
        "to hit goal",
      ),
    };
  });

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
  textLines.push("");
  // Per-recruiter block mirrors the two hero tiles on the dashboard so an
  // email reader gets the same read as the app: for each person, one
  // section for THIS MONTH and one for the whole PROGRAM, each showing
  // actual, goal, pace, and a concrete $/day action line.
  for (const rc of recruiterCards) {
    textLines.push(`${rc.name}`);
    textLines.push(
      `  MTD       actual ${fmtUSD(rc.mtdActual).padStart(10)} ` +
        `(${rc.mtdPlacements} placement${rc.mtdPlacements === 1 ? "" : "s"})`,
    );
    textLines.push(
      `            goal   ${fmtUSD(rc.monthlyGoal).padStart(10)}  ` +
        `pace ${paceLabel(rc.mtdActual, rc.monthlyExpected).padStart(4)}` +
        (rc.mtdAction ? `  · ${rc.mtdAction}` : ""),
    );
    textLines.push(
      `  ${String(t.programHorizonMonths) + "-mo"}      actual ${fmtUSD(rc.programActual).padStart(10)} ` +
        `(${rc.programPlacements} placement${rc.programPlacements === 1 ? "" : "s"})`,
    );
    textLines.push(
      `            goal   ${fmtUSD(rc.programGoal).padStart(10)}  ` +
        `pace ${paceLabel(rc.programActual, rc.programExpected).padStart(4)}` +
        (rc.programAction ? `  · ${rc.programAction}` : ""),
    );
    textLines.push("");
  }
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

  // One "card" per recruiter, each with two side-by-side hero tiles (MTD
  // and program horizon). Uses a nested table for the two tiles because
  // that's the only email-safe way to get equal-width columns across Gmail,
  // Outlook, and Apple Mail. Each tile mirrors the dashboard's hero layout:
  // ACTUAL big number, placements sub, then goal + pace + $/day inside the
  // same tile.
  const heroTile = (
    heading: string,
    actual: number,
    placements: number,
    goal: number,
    expected: number,
    action: string,
    variant: "primary" | "muted",
  ): string => {
    const isPrimary = variant === "primary";
    const bg = isPrimary
      ? "background:linear-gradient(135deg,#0090F0,#0064B8);color:#ffffff;"
      : "background:#f8fafc;color:#0f172a;border:1px solid #e5e7eb;";
    const labelStyle = isPrimary
      ? "color:rgba(255,255,255,0.85);"
      : "color:#64748b;";
    const valueStyle = isPrimary ? "color:#ffffff;" : "color:#0f172a;";
    const dividerStyle = isPrimary
      ? "border-top:1px solid rgba(255,255,255,0.25);"
      : "border-top:1px solid #e5e7eb;";
    const footerLabelStyle = isPrimary
      ? "color:rgba(255,255,255,0.85);"
      : "color:#64748b;";
    const footerValueStyle = isPrimary
      ? "color:#ffffff;"
      : "color:#0f172a;";
    const actionStyle = isPrimary
      ? "color:rgba(255,255,255,0.8);"
      : "color:#475569;";
    return `
    <td width="50%" valign="top" style="padding:0 6px">
      <div style="${bg}border-radius:10px;padding:14px 14px 12px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;font-weight:600;${labelStyle}">${esc(heading)}</div>
        <div style="font-size:22px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums;${valueStyle}">${actual > 0 ? fmtUSD(actual) : "—"}</div>
        <div style="font-size:11px;margin-top:2px;${labelStyle}">${placements} placement${placements === 1 ? "" : "s"}</div>
        <div style="${dividerStyle}margin-top:10px;padding-top:8px">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="font-size:11px">
            <tr>
              <td style="padding:1px 0;text-transform:uppercase;letter-spacing:0.5px;${footerLabelStyle}">Goal</td>
              <td style="padding:1px 0;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;${footerValueStyle}">${fmtUSD(goal)}</td>
            </tr>
            <tr>
              <td style="padding:1px 0;text-transform:uppercase;letter-spacing:0.5px;${footerLabelStyle}">Pace</td>
              <td style="padding:1px 0;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;${footerValueStyle}">${paceBadge(actual, expected)}</td>
            </tr>
            ${action ? `<tr><td colspan="2" style="padding-top:4px;font-variant-numeric:tabular-nums;${actionStyle}">${esc(action)}</td></tr>` : ""}
          </table>
        </div>
      </div>
    </td>`;
  };

  const cardsHtml = recruiterCards
    .map((rc) => {
      return `
      <div style="padding:16px 14px 4px">
        <div style="font-size:13px;font-weight:600;color:#0f172a;margin:0 6px 10px">${esc(rc.name)}</div>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="table-layout:fixed">
          <tr>
            ${heroTile("Actual MTD", rc.mtdActual, rc.mtdPlacements, rc.monthlyGoal, rc.monthlyExpected, rc.mtdAction, "primary")}
            ${heroTile(`Actual ${t.programHorizonMonths}-mo`, rc.programActual, rc.programPlacements, rc.programGoal, rc.programExpected, rc.programAction, "muted")}
          </tr>
        </table>
      </div>`;
    })
    .join("");

  const noteBlock =
    input.note && input.note.trim().length > 0
      ? `<div style="background:#f1f5f9;border-left:3px solid #0090F0;padding:12px 14px;margin:16px 0;border-radius:4px;white-space:pre-wrap">${esc(input.note.trim())}</div>`
      : "";

  // Sits INSIDE the blue gradient hero header, so it needs white ink to
  // stay readable (previously used slate #475569 which vanished on dark blue).
  // Outlook Mac drops rgba() text color and drops CSS opacity, so we spell
  // this as solid #ffffff. Contrast on the dark-blue hero is fine.
  const horizonNote = twoHorizon
    ? `<div style="color:#ffffff;font-size:12px;margin-top:6px">
        <strong style="color:#ffffff">${t.fundingHorizonMonths}-mo underwritten goal</strong> delivered in a
        <strong style="color:#ffffff">${t.programHorizonMonths}-mo</strong> program window — monthly cadence scaled to hit the full total.
      </div>`
    : "";

  // Hero rendered as a bulletproof email table:
  //   • <table bgcolor="#0064B8"> gives a solid fallback that every mail
  //     client (Apple Mail, Outlook, Gmail web, iOS Mail) will paint even
  //     if it strips CSS gradients — which Apple Mail on macOS was doing,
  //     leaving white text on a white background.
  //   • The inline CSS gradient still layers on top for clients that
  //     support it (Gmail web, most webmail), matching the in-app scorecard
  //     hero exactly (#0090F0 → #0064B8 at 135deg).
  //   • Text is spelled with explicit color:#ffffff (not shorthand) and
  //     rgba() opacity because some clients drop `opacity` on div text.
  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a">
  <div style="max-width:640px;margin:0 auto;padding:24px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#0064B8" style="background-color:#0064B8;background-image:linear-gradient(135deg,#0090F0,#0064B8);border-radius:12px;color:#ffffff">
      <tr>
        <td bgcolor="#0064B8" style="background-color:#0064B8;background-image:linear-gradient(135deg,#0090F0,#0064B8);border-radius:12px;padding:20px 22px;color:#ffffff">
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#ffffff">Scorecard</div>
          <div style="font-size:22px;font-weight:600;margin-top:2px;color:#ffffff">${esc(input.channelName)}</div>
          ${input.channelTopic ? `<div style="font-size:13px;margin-top:2px;color:#ffffff">${esc(input.channelTopic)}</div>` : ""}
          <div style="font-size:12px;margin-top:10px;color:#ffffff">
            Program: <strong style="color:#ffffff">${esc(start)}</strong> for <strong style="color:#ffffff">${t.programHorizonMonths} months</strong>
            · <strong style="color:#ffffff">${Math.round(frac * 100)}%</strong> elapsed
          </div>
          ${horizonNote}
        </td>
      </tr>
    </table>

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
      <div style="padding:14px 20px 4px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#64748b;font-weight:600">Recruiters</div>
      <div style="padding:0 8px 12px">${cardsHtml}</div>
    </div>

    <div style="color:#94a3b8;font-size:12px;margin-top:20px;text-align:center">
      Sent from Bulldog Chat · scorecard channel #${esc(input.channelName)}${input.senderName ? ` · by ${esc(input.senderName)}` : ""}
    </div>
  </div>
</body>
</html>`;

  return { text, html };
}
