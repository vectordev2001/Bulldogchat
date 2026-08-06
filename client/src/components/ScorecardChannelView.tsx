/**
 * VTS Recruiter Scorecard channel view (Phase 2.6)
 *
 * Renders a channel of `type === "scorecard"` as a read-only dashboard for
 * everyone with channel access, plus admin/super_admin edit affordances.
 *
 * Layout mirrors TextChannelView's outer shell (14-row header + flex-1 body)
 * so Home.tsx can drop this in without touching the surrounding chrome.
 *
 * Numbers:
 *   F = fundingHorizonMonths (defaults to 6 for VTS underwriting)
 *   P = programHorizonMonths (defaults to 5 for VTS Aug→Dec 2026)
 *
 *   program revenue target = F-month salary / (1 - profitTarget)   ← fixed by funding
 *   monthly target         = program revenue target / P              ← cadence within window
 *   floor placements       = round(program revenue target / averageFee)
 *   stretch                = monthly * stretchMultiplier
 *   pace                   = actuals in program window / expected pace to date
 *
 * Two horizons on purpose: VTS underwrote a 6-month salary/profit model,
 * but the actual program runs Aug→Dec (5 months). The total dollar goal
 * stays the 6-month underwritten number — monthly targets scale UP so
 * the shorter window still delivers it. Setting F == P recovers the
 * classic "pro-rata by program length" behavior.
 *
 * The program window is a FIXED forward calendar range (programStartMonth
 * through programStartMonth + P months) — not a rolling trailing window.
 * On Aug 4 2026 with an Aug 2026 start and P=5, the elapsed fraction is
 * ~0.024, not ~0.85.
 *
 * Salaries are never rendered in this view — only derived $ targets. The
 * server strips salaries from the non-admin projection as a defense in
 * depth; this view also does not show salaries in the admin projection to
 * keep the peer-visible surface clean (admins see them in the edit dialog).
 */

import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { DollarSign, Loader2, Mail, Pencil, Plus, Printer, Trash2, TrendingUp, Trophy, Users, X } from "lucide-react";
import type { ApiChannel } from "@/types/api";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/* ─────────────────── types ─────────────────── */

interface Recruiter {
  key: string;
  name: string;
  monthlySalary?: number; // present only when the caller is admin
}
// Phase 2.6.1 — admin-selected view knobs. Optional so a config saved
// before display presets landed still round-trips through this type
// without a migration.
interface ScorecardDisplay {
  preset?: "compact" | "comfortable" | "spacious";
  density?: "1-col" | "2-col" | "3-col";
  sortBy?: "name" | "pace-desc" | "pace-asc" | "actual-mtd-desc";
  // Phase 2.6.2 — leaderboard metric (or "off" to hide the panel).
  leaderboardMetric?: "off" | "mtd-fee" | "pace" | "rolling-3mo-fee";
}
interface ScorecardConfig {
  averageFee: number;
  profitTarget: number;
  stretchMultiplier: number;
  thresholds: { green: number; yellow: number };
  recruiters: Recruiter[];
  display?: ScorecardDisplay;
  // Fixed forward program window — defaults live in the shared schema;
  // these are optional on the wire so pre-existing configs stay valid.
  programStartMonth?: string; // "YYYY-MM"
  programHorizonMonths?: number;
  // Funding horizon that sized the total revenue target. See
  // scorecardConfigInputSchema for the full rationale.
  fundingHorizonMonths?: number;
  // Extra revenue tier on top of the program total — e.g. VTS $500k of
  // startup capital the team wants to earn back. Adds a stretch chip
  // to the top card and to each recruiter card. Zero suppresses it.
  startupCostRecoveryTarget?: number;
}

// Defaults for the fixed forward program window — mirror the shared
// schema defaults so a config that predates these fields still renders
// the intended VTS Aug→Dec 2026 horizon.
const DEFAULT_PROGRAM_START_MONTH = "2026-08";
const DEFAULT_PROGRAM_HORIZON_MONTHS = 5;
// VTS salaries were underwritten against 6 months of cost, so that is
// the horizon that sizes the whole-program revenue target. The program
// itself only runs 5 months, so monthly cadence = total / 5.
const DEFAULT_FUNDING_HORIZON_MONTHS = 6;
// Default startup/seed cost the team is asked to recover on top of the
// program revenue target. Zero suppresses the stretch tier in the UI.
const DEFAULT_STARTUP_COST_RECOVERY = 500_000;
interface Actual {
  recruiterKey: string;
  periodMonth: string; // "YYYY-MM"
  placementsCount: number;
  feeAmountCents: number;
  notes?: string | null;
}
interface ScorecardResponse {
  channelId: number;
  config: ScorecardConfig;
  actuals: Actual[];
  canEdit: boolean;
  updatedAt: number;
}
// Phase 2.6.3 — per-placement rows. Aggregate `Actual` above is still
// the read model on the dashboard; this is what the click-through
// popovers show and what the new entry dialog writes.
interface Placement {
  id: number;
  recruiterKey: string;
  periodMonth: string; // "YYYY-MM"
  placedAt: string; // "YYYY-MM-DD"
  candidateName: string | null;
  clientName: string | null;
  feeAmountCents: number;
  notes: string | null;
  createdByUserId: number;
  createdAt: number;
}

interface Props {
  channel: ApiChannel;
}

/* ─────────────────── helpers ─────────────────── */

const fmtUSD = (dollars: number) =>
  dollars.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Compute per-recruiter targets from the config. Pure — no side effects.
 *
 *  Two horizons drive the numbers on purpose:
 *    • fundingHorizonMonths (F) — how the salaries were underwritten.
 *      This sizes the TOTAL revenue target, so shortening the program
 *      window does NOT shrink the goal you promised to hit.
 *    • programHorizonMonths (P) — how long the program actually runs.
 *      This sizes MONTHLY cadence: monthly = total / P. When P < F,
 *      monthly targets scale up so the same total lands in less time.
 *
 *  Concrete VTS example: monthlySalary=$100k, profit=30%, F=6, P=5
 *    totalTarget  = 100k * 6 / 0.7  = $857k   (unchanged 6-month goal)
 *    monthly      = 857k / 5        = $171k   (up ~20% vs 6-month cadence)
 *    floor        = round(857k / averageFee)  (goal-anchored, not cadence)
 *    stretch      = monthly * stretchMultiplier
 *
 *  Field names keep the historical `sixMonth` label to avoid rippling
 *  into every consumer; the value is “whole-program revenue target,”
 *  now sized by F rather than P.
 *
 *  Stretch tier (Phase 2.6.x — startup-cost recovery):
 *    startupCostRecovery is an ADDITIONAL dollar amount the team is
 *    asked to earn on top of the program total. It adds four new
 *    fields to the top-level return (teamStretch* + startupCostRecovery)
 *    and three per-recruiter fields (stretchExtra, stretchTotalRevenue,
 *    stretchMonthlyRevenue). The per-recruiter startup share is salary-
 *    proportional so recruiters carrying more monthly cost also carry a
 *    bigger slice of the recovery target. When startupCostRecovery == 0,
 *    the stretch chip and card row simply don't render. */
function computeTargets(cfg: ScorecardConfig) {
  const programHorizonMonths = cfg.programHorizonMonths ?? DEFAULT_PROGRAM_HORIZON_MONTHS;
  const fundingHorizonMonths = cfg.fundingHorizonMonths ?? DEFAULT_FUNDING_HORIZON_MONTHS;
  const startupCostRecovery = Math.max(0, cfg.startupCostRecoveryTarget ?? DEFAULT_STARTUP_COST_RECOVERY);
  const totalMonthlySalary = cfg.recruiters.reduce((s, r) => s + (r.monthlySalary ?? 0), 0);
  // Total salary is sized by the FUNDING horizon — the underwritten cost
  // base — not the program horizon. Shortening the program does not
  // reduce what we promised to deliver against.
  const totalFundingSalary = totalMonthlySalary * fundingHorizonMonths;
  const denom = Math.max(0.01, 1 - cfg.profitTarget);
  const teamSixMonthRevenue = totalFundingSalary / denom; // total program revenue target
  // Monthly cadence uses the PROGRAM horizon so the same total lands in
  // the actual window (5 months for VTS, hence ~20% higher monthly bars).
  const teamMonthlyRevenue = teamSixMonthRevenue / programHorizonMonths;
  const teamFloorPlacements = Math.round(teamSixMonthRevenue / Math.max(1, cfg.averageFee));

  // Stretch tier = program total + startup cost we want to recover.
  // The same actuals fill it, so hitting stretch means we covered
  // salaries + underwritten profit + startup capital. Split across
  // recruiters PROPORTIONALLY TO SALARY so higher-paid recruiters
  // carry more of the stretch, matching how the program goal already
  // scales with each person's monthly salary.
  const teamStretchRevenue = teamSixMonthRevenue + startupCostRecovery;
  const teamStretchMonthly = teamStretchRevenue / programHorizonMonths;
  const teamStretchFloorPlacements = Math.round(teamStretchRevenue / Math.max(1, cfg.averageFee));
  const salaryBase = totalMonthlySalary > 0 ? totalMonthlySalary : cfg.recruiters.length; // avoid /0

  const perRecruiter = cfg.recruiters.map((r) => {
    const salaryFunding = (r.monthlySalary ?? 0) * fundingHorizonMonths;
    const sixMonthRevenue = salaryFunding / denom;
    const monthly = sixMonthRevenue / programHorizonMonths;
    const floorPlacements = Math.round(sixMonthRevenue / Math.max(1, cfg.averageFee));
    // Salary-proportional stretch share. When salary is unknown on the
    // non-admin projection we fall back to an equal split so the field
    // still reads sensibly (and no one sees a $0 stretch chip).
    const salaryShare = totalMonthlySalary > 0 && r.monthlySalary != null
      ? r.monthlySalary / salaryBase
      : 1 / cfg.recruiters.length;
    const stretchExtra = startupCostRecovery * salaryShare;
    const stretchTotalRevenue = sixMonthRevenue + stretchExtra;
    return {
      key: r.key,
      name: r.name,
      // Non-admin projection has monthlySalary undefined → all these are 0.
      // In that case we still want to render *something* useful, so we
      // fall back to the team's per-recruiter average.
      monthly: r.monthlySalary != null ? monthly : teamMonthlyRevenue / cfg.recruiters.length,
      sixMonth: r.monthlySalary != null ? sixMonthRevenue : teamSixMonthRevenue / cfg.recruiters.length,
      floorPlacements: r.monthlySalary != null
        ? floorPlacements
        : Math.round(teamFloorPlacements / cfg.recruiters.length),
      stretch: (r.monthlySalary != null ? monthly : teamMonthlyRevenue / cfg.recruiters.length) * cfg.stretchMultiplier,
      // New stretch-tier fields (program + startup-recovery share).
      // `stretchTotalRevenue` is the per-recruiter share of the combined
      // goal (program-window revenue + startup-cost share); everything
      // downstream keys off it.
      stretchExtra: r.monthlySalary != null ? stretchExtra : startupCostRecovery / cfg.recruiters.length,
      stretchTotalRevenue: r.monthlySalary != null
        ? stretchTotalRevenue
        : (teamSixMonthRevenue + startupCostRecovery) / cfg.recruiters.length,
      stretchMonthlyRevenue: (r.monthlySalary != null
        ? stretchTotalRevenue
        : (teamSixMonthRevenue + startupCostRecovery) / cfg.recruiters.length) / programHorizonMonths,
      hasSalary: r.monthlySalary != null,
    };
  });

  return {
    horizonMonths: programHorizonMonths,
    fundingHorizonMonths,
    totalSixMonthSalary: totalFundingSalary,
    teamSixMonthRevenue,
    teamMonthlyRevenue,
    teamFloorPlacements,
    startupCostRecovery,
    teamStretchRevenue,
    teamStretchMonthly,
    teamStretchFloorPlacements,
    perRecruiter,
  };
}

/** YYYY-MM keys for the last N months, most recent first. */
function recentMonths(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    out.push(`${y}-${m}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

/** Fraction-of-month elapsed for the current YYYY-MM, capped 0..1. */
function fractionOfCurrentMonthElapsed(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  return Math.min(1, Math.max(0, (Date.now() - start) / Math.max(1, end - start)));
}

/**
 * How far through the fixed forward program window we are, as a fraction
 * clamped to [0, 1].
 *
 *   (monthsSinceStart + fractionOfCurrentMonth) / horizonMonths
 *
 * `startMonth` is "YYYY-MM". If today is before the program start, this
 * returns 0; after the horizon it saturates at 1. On Aug 4 2026 with a
 * start of "2026-08" and horizon = 5, this returns ~0.024 (the current
 * month is 0/5 complete plus ~12% of month 1 → ~2.4% of program).
 *
 * This is the single source of truth for “where in the program are we?”
 * used by the team card, the recruiter heat map, and the per-recruiter
 * card colorization. The previous math — `(5 + monthElapsed) / 6` —
 * modelled a rolling trailing 6-month window and is intentionally removed:
 * a fixed forward window must not saturate near 1 on day 1.
 */
function fractionOfProgramElapsed(
  startMonth: string,
  horizonMonths: number,
): number {
  const m = /^(\d{4})-(\d{2})$/.exec(startMonth);
  if (!m || horizonMonths <= 0) return 0;
  const startY = Number(m[1]);
  const startMo = Number(m[2]) - 1; // 0-indexed month
  const now = new Date();
  const monthsSinceStart =
    (now.getFullYear() - startY) * 12 + (now.getMonth() - startMo);
  const raw = (monthsSinceStart + fractionOfCurrentMonthElapsed()) / horizonMonths;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Shared pace → color helper. Used by every colorized surface — top team
 * progress bar, per-recruiter card left-border, hero tile edge. Keeping
 * this in one place means the heat scale is consistent everywhere.
 *
 * Returns a hex string with a matching `label` for the a11y sr-text.
 */
function paceHeat(
  pace: number,
  hasActuals: boolean,
  thresholds: { green: number; yellow: number },
): { color: string; label: string } {
  if (!hasActuals) return { color: "#94a3b8", label: "No data" }; // slate-400
  if (pace >= thresholds.green) return { color: "#10b981", label: "On pace" }; // emerald-500
  if (pace >= thresholds.yellow) return { color: "#f59e0b", label: "Behind pace" }; // amber-500
  if (pace > 0) return { color: "#ef4444", label: "Off track" }; // red-500
  return { color: "#94a3b8", label: "No data" };
}

/**
 * Recruiter heat-map: each recruiter rendered as a variable-size tile,
 * colored by pace vs the FIXED forward program window (default: Aug→Dec
 * 2026, 5 months), sized by attainment fraction of that program goal so
 * outperformers grow and underperformers shrink. This is the "at a
 * glance" visual that lives between the team stats and the detailed
 * recruiter cards.
 *
 * Sizing model: base tile row is a CSS grid of equal cells; each tile's
 * `flex-grow` is set from a normalized attainment ratio so bigger =
 * further ahead. A floor of 0.55 keeps zero/low attainers visible and
 * legible. Clicking a tile scrolls the matching recruiter card into view.
 *
 * Coloring signal is window-pace-only: attained-in-program-so-far divided
 * by expected-by-now given the fraction of the program elapsed. There is
 * no monthly fallback — on day 1 of a 5-month program, every recruiter
 * with zero placements is legitimately at 0% pace, not “no data.”
 */
function RecruiterHeatmap({
  perRecruiter,
  programFeeByRecruiter,
  programFractionElapsed,
  horizonMonths,
  thresholds,
}: {
  perRecruiter: Array<{ key: string; name: string; monthly: number; sixMonth: number }>;
  programFeeByRecruiter: Map<string, { fee: number; placements: number }>;
  programFractionElapsed: number;
  horizonMonths: number;
  thresholds: { green: number; yellow: number };
}) {
  if (perRecruiter.length === 0) return null;

  // Pre-compute per-recruiter attainment + pace + heat, then normalize the
  // "size score" across the row so we don't have to pick absolute pixel
  // widths. Size score = program-window attainment fraction, floored at
  // 0.55 so no-data / off-track tiles are still readable.
  const tiles = perRecruiter.map((r) => {
    const programActual = programFeeByRecruiter.get(r.key) ?? { fee: 0, placements: 0 };
    // Window pace — attained vs expected-by-now for THIS program window.
    // The only coloring signal; no monthly fallback.
    const expectedByNow = r.sixMonth * programFractionElapsed;
    const windowPace = expectedByNow > 0 ? programActual.fee / expectedByNow : 0;
    const windowAttain = r.sixMonth > 0 ? programActual.fee / r.sixMonth : 0;
    const hasActuals = programActual.fee > 0;
    const heat = paceHeat(windowPace, hasActuals, thresholds);
    // Size score: clamp attainment to [0.55, 1.5] so overachievers grow
    // ~2.7× the min tile without any single tile eating the row.
    const sizeScore = Math.min(1.5, Math.max(0.55, windowAttain));
    return { r, programActual, windowPace, windowAttain, heat, sizeScore, hasActuals };
  });

  return (
    <div className="rounded-2xl bg-white dark:bg-[hsl(var(--vs-surface-elevated))] border border-[hsl(var(--vs-border))] p-4 md:p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider font-medium text-[hsl(var(--vs-text-muted))]">
          <TrendingUp className="w-3.5 h-3.5" />
          Recruiter heat map · {horizonMonths}‑month program
        </div>
        <div className="hidden sm:flex items-center gap-3 text-[10px] text-[hsl(var(--vs-text-muted))]">
          <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: "#10b981" }} /> On pace</span>
          <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: "#f59e0b" }} /> Behind</span>
          <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: "#ef4444" }} /> Off track</span>
          <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: "#94a3b8" }} /> No data</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {tiles.map((t, i) => (
          <motion.button
            key={t.r.key}
            type="button"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2, delay: 0.02 * i }}
            onClick={() => {
              const el = document.querySelector<HTMLElement>(`[data-testid="recruiter-card-${t.r.key}"]`);
              el?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
            className="relative overflow-hidden rounded-xl px-3 py-3 text-left border transition hover:brightness-105 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#0090F0]"
            style={{
              // Tile fill: pace color at low opacity so text stays legible.
              background: `linear-gradient(135deg, ${t.heat.color}26 0%, ${t.heat.color}14 100%)`,
              borderColor: `${t.heat.color}66`,
              flexGrow: t.sizeScore,
              // Min basis keeps tiles readable at small sizes; max keeps
              // one overachiever from eating the whole row.
              flexBasis: "140px",
              minWidth: "140px",
              maxWidth: "320px",
            }}
            aria-label={`${t.r.name}: ${t.heat.label}${t.hasActuals ? `, ${Math.round(t.windowAttain * 100)}% of ${horizonMonths}-month goal` : ""}`}
            data-testid={`recruiter-heatmap-${t.r.key}`}
          >
            <div
              className="absolute top-0 left-0 right-0 h-1"
              style={{ background: t.heat.color, opacity: t.hasActuals ? 1 : 0.4 }}
              aria-hidden
            />
            <div className="flex items-baseline justify-between gap-2">
              <div className="font-semibold text-[13px] text-[hsl(var(--vs-text))] truncate">{t.r.name}</div>
              <div
                className="text-[10px] font-semibold uppercase tracking-wider tabular-nums whitespace-nowrap"
                style={{ color: t.heat.color }}
              >
                {t.hasActuals ? `${Math.round(t.windowAttain * 100)}%` : "—"}
              </div>
            </div>
            <div className="mt-1 text-[11px] text-[hsl(var(--vs-text-muted))] tabular-nums">
              {t.hasActuals
                ? `${fmtUSD(t.programActual.fee)} of ${fmtUSD(t.r.sixMonth)}`
                : `Goal ${fmtUSD(t.r.sixMonth)}`}
            </div>
            <div className="mt-2 text-[10px] font-medium" style={{ color: t.heat.color }}>
              {t.heat.label}
            </div>
          </motion.button>
        ))}
      </div>
      <div className="mt-3 text-[10px] text-[hsl(var(--vs-text-muted))]">
        Tile size grows with {horizonMonths}‑month attainment; color reflects window pace. Tap a tile to jump to that recruiter.
      </div>
    </div>
  );
}

/* ─────────────────── main view ─────────────────── */

export function ScorecardChannelView({ channel }: Props) {
  const q = useQuery<ScorecardResponse>({
    queryKey: ["/api/channels", channel.id, "scorecard"],
    queryFn: () => apiRequest<ScorecardResponse>("GET", `/api/channels/${channel.id}/scorecard`),
    staleTime: 15_000,
  });

  const [editOpen, setEditOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  // Export affordances. Print piggybacks on the browser print dialog
  // (users pick “Save as PDF” for a PDF); Email posts a rendered
  // snapshot to the server which sends it via SendGrid with an HTML
  // body and a plain-text fallback.
  const [emailOpen, setEmailOpen] = useState(false);

  if (q.isLoading || !q.data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-vs-blue" />
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-red-500 px-6 text-center">
        Couldn't load the scorecard. If this channel was just created, refresh in a moment.
      </div>
    );
  }

  const { config, actuals, canEdit } = q.data;
  const targets = computeTargets(config);
  const currentMonth = recentMonths(1)[0];
  const monthElapsed = fractionOfCurrentMonthElapsed();

  // Fixed forward program window. Defaults preserve VTS Aug→Dec 2026 for
  // configs saved before these fields existed.
  const programStartMonth = config.programStartMonth ?? DEFAULT_PROGRAM_START_MONTH;
  const horizonMonths = targets.horizonMonths;
  // The single source of truth for pace across the top card, the heat
  // map, and each recruiter card. On day 1 of the program this is ~0, not
  // ~0.85 like the old rolling-window math produced.
  const programFractionElapsed = fractionOfProgramElapsed(programStartMonth, horizonMonths);

  // Roll up current-month actuals per recruiter for the MTD hero tiles.
  const currentMonthByRecruiter = new Map<string, Actual>();
  for (const a of actuals) {
    if (a.periodMonth === currentMonth) currentMonthByRecruiter.set(a.recruiterKey, a);
  }

  // Build the set of YYYY-MM keys inside the program window so we can
  // filter actuals down to “in-program placements only.” The window is
  // ALWAYS the fixed forward calendar range — not a trailing rolling
  // window — so placements outside programStartMonth..+horizon don't
  // count toward attainment or pace.
  const programMonths: string[] = [];
  {
    const m = /^(\d{4})-(\d{2})$/.exec(programStartMonth);
    if (m) {
      const startY = Number(m[1]);
      const startMo = Number(m[2]) - 1;
      for (let i = 0; i < horizonMonths; i++) {
        const d = new Date(startY, startMo + i, 1);
        const y = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        programMonths.push(`${y}-${mm}`);
      }
    }
  }
  const programMonthsSet = new Set(programMonths);
  // Popover range — first→last month of the program window.
  const sixMoRange = {
    from: programMonths[0] ?? currentMonth,
    to: programMonths[programMonths.length - 1] ?? currentMonth,
  };
  const trailing6ByRecruiter = new Map<string, { fee: number; placements: number }>();
  for (const a of actuals) {
    if (!programMonthsSet.has(a.periodMonth)) continue;
    const entry = trailing6ByRecruiter.get(a.recruiterKey) ?? { fee: 0, placements: 0 };
    entry.fee += (a.feeAmountCents ?? 0) / 100;
    entry.placements += a.placementsCount ?? 0;
    trailing6ByRecruiter.set(a.recruiterKey, entry);
  }

  // Team-wide MTD totals — the top card shows these against the monthly
  // team goal so the whole surface has an anchor "where are we RIGHT now"
  // number before scanning individual recruiter cards.
  let teamMTDFee = 0;
  let teamMTDPlacements = 0;
  let teamMTDHasAnyActuals = false;
  for (const a of actuals) {
    if (a.periodMonth !== currentMonth) continue;
    teamMTDFee += (a.feeAmountCents ?? 0) / 100;
    teamMTDPlacements += a.placementsCount ?? 0;
    teamMTDHasAnyActuals = true;
  }
  const teamMonthlyGoal = targets.teamMonthlyRevenue;
  const teamProgress = teamMonthlyGoal > 0 ? teamMTDFee / teamMonthlyGoal : 0;
  const teamExpectedByNow = teamMonthlyGoal * monthElapsed;
  const teamPace = teamExpectedByNow > 0 ? teamMTDFee / teamExpectedByNow : 0;
  const teamHeat = paceHeat(teamPace, teamMTDHasAnyActuals, config.thresholds);

  // Team-wide program-window totals — the top card also shows this
  // against the whole-program team goal so the reader sees BOTH "where
  // the team is this month" and "where the team is on the {H}-month
  // program." The window is FIXED (Aug→Dec 2026 by default), so pace
  // uses fractionOfProgramElapsed — the old rolling `(5 + monthElapsed)
  // / 6` math is intentionally gone.
  let team6MoFee = 0;
  let team6MoPlacements = 0;
  trailing6ByRecruiter.forEach((v) => {
    team6MoFee += v.fee;
    team6MoPlacements += v.placements;
  });
  const team6MoHasAnyActuals = team6MoFee > 0;
  const team6MoGoal = targets.teamSixMonthRevenue;
  const team6MoProgress = team6MoGoal > 0 ? team6MoFee / team6MoGoal : 0;
  const team6MoExpectedByNow = team6MoGoal * programFractionElapsed;
  const team6MoPace = team6MoExpectedByNow > 0 ? team6MoFee / team6MoExpectedByNow : 0;
  const team6MoHeat = paceHeat(team6MoPace, team6MoHasAnyActuals, config.thresholds);

  // Phase 2.6.1 — display presets. Read admin-selected view knobs off the
  // config, falling back to defaults so pre-2.6.1 configs render unchanged.
  const display = {
    preset: config.display?.preset ?? "comfortable",
    density: config.display?.density ?? "3-col",
    sortBy: config.display?.sortBy ?? "name",
    leaderboardMetric: config.display?.leaderboardMetric ?? "off",
  } as const;
  const gridClass =
    display.density === "1-col" ? "grid grid-cols-1 gap-3 md:gap-4"
    : display.density === "2-col" ? "grid grid-cols-1 sm:grid-cols-2 gap-3 md:gap-4"
    : "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4";
  // Preset controls card padding and hero font size. Kept as concrete
  // Tailwind strings rather than dynamic class-name math so JIT compiles them.
  const cardPadClass =
    display.preset === "compact" ? "p-3"
    : display.preset === "spacious" ? "p-6"
    : "p-5";
  const heroSizeClass =
    display.preset === "compact" ? "text-[16px]"
    : display.preset === "spacious" ? "text-[24px]"
    : "text-[20px]";
  const nameSizeClass =
    display.preset === "compact" ? "text-[13px]"
    : display.preset === "spacious" ? "text-[17px]"
    : "text-[15px]";

  // Sort recruiter rows for display. Base list is targets.perRecruiter
  // (which preserves config.recruiters order); each sort mode re-derives
  // the current-month pace to rank against.
  const sortedPerRecruiter = [...targets.perRecruiter];
  if (display.sortBy !== "name") {
    sortedPerRecruiter.sort((a, b) => {
      const actualA = currentMonthByRecruiter.get(a.key);
      const actualB = currentMonthByRecruiter.get(b.key);
      const feeA = (actualA?.feeAmountCents ?? 0) / 100;
      const feeB = (actualB?.feeAmountCents ?? 0) / 100;
      if (display.sortBy === "actual-mtd-desc") return feeB - feeA;
      // pace-desc / pace-asc — recruiters with no target sort last either way.
      const paceA = a.monthly > 0 ? feeA / (a.monthly * monthElapsed || 1) : -1;
      const paceB = b.monthly > 0 ? feeB / (b.monthly * monthElapsed || 1) : -1;
      return display.sortBy === "pace-desc" ? paceB - paceA : paceA - paceB;
    });
  } else {
    sortedPerRecruiter.sort((a, b) => a.name.localeCompare(b.name));
  }

  return (
    <div
      className="flex-1 min-h-0 flex flex-col bg-[hsl(var(--vs-surface))]"
      /* Marks this subtree as the print isolation root. The @media print
         rules in index.css hide the rest of the app shell and unroll this
         node into the document flow so the whole scorecard prints (or
         saves to PDF via the browser dialog) without clipping. */
      data-print-root="scorecard"
    >
      {/* Header — matches TextChannelView's 14-row header on desktop and
          stacks cleanly on narrow viewports.

          Layout:
            • mobile:  three rows — title (full width, truncated), subtitle
              (truncated), action buttons (their own line). Auto height so
              nothing crowds or wraps into an unreadable ribbon.
            • sm+:     single 56px row — title/subtitle stacked next to
              the icon on the left, actions right-aligned. Matches the
              rest of the app's channel headers.

          The old header collapsed title + subtitle + “Log placements”
          into one flex row inside a fixed 56px shell, which crushed the
          subtitle and pushed the primary CTA past the viewport on phones. */}
      <div className="border-b border-[hsl(var(--vs-border))] px-4 md:px-6 py-2 sm:py-0 sm:h-14 shrink-0">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3 sm:h-full">
          {/* Identity row — icon + title stack. Grows to fill remaining
              width on desktop; on mobile it's the full width. min-w-0 is
              critical so the truncate on the title actually clips. */}
          <div className="flex items-center gap-3 min-w-0 sm:flex-1">
            <div className="w-8 h-8 rounded-full flex items-center justify-center bg-gradient-to-br from-[#0090F0] to-[#0064B8] shadow-sm shrink-0">
              <DollarSign className="w-4 h-4 text-white" strokeWidth={2.5} />
            </div>
            <div className="min-w-0 flex-1">
              <div
                className="font-display text-[hsl(var(--vs-text))] text-base truncate"
                data-testid="scorecard-header-title"
              >
                {channel.name}
              </div>
              {channel.topic && (
                <div
                  className="text-[11px] text-[hsl(var(--vs-text-muted))] truncate"
                  data-testid="scorecard-header-subtitle"
                >
                  {channel.topic}
                </div>
              )}
            </div>
          </div>
          {/* Action row. Print + Email are visible to anyone who can
             see the scorecard (they don't mutate data); Log placements
             and Edit config remain admin-only via `canEdit`. On mobile
             the row wraps to its own line beneath the title stack. The
             whole row is `no-print` so the buttons don't show up in the
             printed page or PDF export. */}
          <div
            className="flex items-center gap-2 sm:ml-auto sm:shrink-0 no-print"
            data-testid="scorecard-header-actions"
            data-no-print="true"
          >
            <button
              type="button"
              onClick={() => window.print()}
              className="h-8 w-8 rounded-full flex items-center justify-center text-[hsl(var(--vs-text-muted))] hover:text-[#0090F0] hover-elevate transition shrink-0"
              title="Print / Save as PDF"
              data-testid="button-print-scorecard"
            >
              <Printer className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setEmailOpen(true)}
              className="h-8 w-8 rounded-full flex items-center justify-center text-[hsl(var(--vs-text-muted))] hover:text-[#0090F0] hover-elevate transition shrink-0"
              title="Email scorecard"
              data-testid="button-email-scorecard"
            >
              <Mail className="w-4 h-4" />
            </button>
            {canEdit && (
              <>
                <button
                  type="button"
                  onClick={() => setLogOpen(true)}
                  className="h-8 px-3 rounded-full text-[13px] font-medium bg-[#0090F0] text-white hover:bg-[#0080D8] active:scale-[0.98] transition shadow-[0_1px_2px_rgba(0,144,240,0.35)] whitespace-nowrap"
                  data-testid="button-log-actuals"
                >
                  <Plus className="w-3.5 h-3.5 inline -ml-0.5 mr-1 -mt-0.5" />
                  Log placements
                </button>
                <button
                  type="button"
                  onClick={() => setEditOpen(true)}
                  className="h-8 w-8 rounded-full flex items-center justify-center text-[hsl(var(--vs-text-muted))] hover:text-[#0090F0] hover-elevate transition shrink-0"
                  title="Edit scorecard config"
                  data-testid="button-edit-config"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-8 py-6 md:py-8">
        <div className="max-w-5xl mx-auto space-y-6">
          {/* Team summary card — the top hero. Leads with the current-month
              TEAM progress bar (MTD actuals vs monthly team goal, heated by
              pace) so the first thing anyone sees is "where is the team right
              now?" The program-horizon + monthly + floor + profit targets
              follow as reference. */}
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="rounded-2xl bg-gradient-to-br from-[#0090F0] to-[#0064B8] text-white p-6 md:p-7 shadow-[0_10px_30px_-12px_rgba(0,100,184,0.55)]"
          >
            {/* Row 1: current team position */}
            <div className="flex items-center gap-2 text-white/80 text-[12px] uppercase tracking-wider font-medium">
              <TrendingUp className="w-3.5 h-3.5" />
              Team — this month
            </div>
            <div className="mt-2 flex items-end justify-between gap-4 flex-wrap">
              <div>
                <div className="font-display text-[36px] md:text-[44px] leading-none tabular-nums">
                  {teamMTDHasAnyActuals ? fmtUSD(teamMTDFee) : "—"}
                </div>
                <div className="mt-1 text-[12px] text-white/80">
                  {teamMTDHasAnyActuals
                    ? `${teamMTDPlacements} placement${teamMTDPlacements === 1 ? "" : "s"} · ${Math.round(teamProgress * 100)}% of ${fmtUSD(teamMonthlyGoal)} monthly goal`
                    : `Awaiting first placement of the month · goal ${fmtUSD(teamMonthlyGoal)}`}
                </div>
              </div>
              <div className="text-right">
                <div
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                  style={{ background: teamHeat.color, color: "white" }}
                >
                  {teamHeat.label}
                  {teamMTDHasAnyActuals && (
                    <span className="opacity-80 font-normal">
                      · pace {Math.round(teamPace * 100)}%
                    </span>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-white/70 tabular-nums">
                  Today ≡ {Math.round(monthElapsed * 100)}% of month
                </div>
              </div>
            </div>
            {/* Team monthly progress bar. Container spans 0–130% so
                overachievement is visible without exploding the row.
                Two markers: dashed = today's expected pace, solid =
                100% goal. */}
            <div className="mt-3 relative h-3 rounded-full bg-white/15 overflow-hidden" aria-label="Team monthly progress">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(1.3, Math.max(0, teamProgress)) * 100 / 1.3}%` }}
                transition={{ duration: 0.6, ease: "easeOut" }}
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ background: teamHeat.color, opacity: teamMTDHasAnyActuals ? 0.95 : 0.4 }}
              />
              {/* Pace marker (today, pro-rated) */}
              <div
                className="absolute inset-y-0 border-l border-dashed border-white/70"
                style={{ left: `${(monthElapsed * 100) / 1.3}%` }}
                aria-hidden
              />
              {/* 100% goal marker */}
              <div
                className="absolute inset-y-0 border-l-2 border-white"
                style={{ left: `${100 / 1.3}%` }}
                aria-hidden
              />
            </div>

            {/* Program-horizon team progress — second, longer-horizon read.
                Shows in-window fee vs the team {H}-month goal, with the
                dashed marker at the elapsed fraction of the program. */}
            <div className="mt-4 flex items-center gap-2 text-white/80 text-[12px] uppercase tracking-wider font-medium">
              <TrendingUp className="w-3.5 h-3.5" />
              Team — {horizonMonths}-month horizon
            </div>
            <div className="mt-2 flex items-end justify-between gap-4 flex-wrap">
              <div>
                <div className="font-display text-[28px] md:text-[34px] leading-none tabular-nums">
                  {team6MoHasAnyActuals ? fmtUSD(team6MoFee) : "—"}
                </div>
                <div className="mt-1 text-[12px] text-white/80">
                  {team6MoHasAnyActuals
                    ? `${team6MoPlacements} placement${team6MoPlacements === 1 ? "" : "s"} · ${Math.round(team6MoProgress * 100)}% of ${fmtUSD(team6MoGoal)} ${horizonMonths}-mo goal`
                    : `No placements yet in the ${horizonMonths}-month program · goal ${fmtUSD(team6MoGoal)}`}
                </div>
              </div>
              <div className="text-right">
                <div
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                  style={{ background: team6MoHeat.color, color: "white" }}
                >
                  {team6MoHeat.label}
                  {team6MoHasAnyActuals && (
                    <span className="opacity-80 font-normal">
                      · pace {Math.round(team6MoPace * 100)}%
                    </span>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-white/70 tabular-nums">
                  Today ≡ {Math.round(programFractionElapsed * 100)}% of {horizonMonths}‑mo
                </div>
              </div>
            </div>
            <div className="mt-3 relative h-3 rounded-full bg-white/15 overflow-hidden" aria-label={`Team ${horizonMonths}-month progress`}>
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(1.3, Math.max(0, team6MoProgress)) * 100 / 1.3}%` }}
                transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ background: team6MoHeat.color, opacity: team6MoHasAnyActuals ? 0.95 : 0.4 }}
              />
              <div
                className="absolute inset-y-0 border-l border-dashed border-white/70"
                style={{ left: `${(programFractionElapsed * 100) / 1.3}%` }}
                aria-hidden
              />
              <div
                className="absolute inset-y-0 border-l-2 border-white"
                style={{ left: `${100 / 1.3}%` }}
                aria-hidden
              />
            </div>

            {/* Row 2: reference targets.

                When funding ≠ program (VTS: 6-month underwriting delivered
                in a 5-month window), the sub-copy makes both horizons
                explicit so "Team revenue target" reads as a 6-month goal
                and "Monthly team target" reads as its scaled-up cadence.
                When funding == program, both labels collapse to the
                classic single-horizon phrasing. */}
            <div className="mt-5 pt-4 border-t border-white/15">
              <div className="flex items-center gap-2 text-white/70 text-[11px] uppercase tracking-wider font-medium mb-2">
                {horizonMonths}-month reference
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
                <SummaryStat
                  label="Team revenue target"
                  value={fmtUSD(targets.teamSixMonthRevenue)}
                  sub={
                    targets.fundingHorizonMonths !== horizonMonths
                      ? `${targets.fundingHorizonMonths}-mo goal · delivered in ${horizonMonths} mo`
                      : `${horizonMonths} months`
                  }
                />
                <SummaryStat
                  label="Monthly team target"
                  value={fmtUSD(targets.teamMonthlyRevenue)}
                  sub={
                    targets.fundingHorizonMonths !== horizonMonths
                      ? `per month (${horizonMonths}-mo cadence)`
                      : "per month"
                  }
                />
                <SummaryStat
                  label="Floor placements"
                  value={String(targets.teamFloorPlacements)}
                  sub={`at ${fmtUSD(config.averageFee)} avg fee`}
                />
                <SummaryStat
                  label="Profit floor"
                  value={`${Math.round(config.profitTarget * 100)}%`}
                  sub={`${config.stretchMultiplier.toFixed(2)}× stretch`}
                />
              </div>

              {/* Stretch tier chip — program total + startup-cost
                  recovery. Shown only when startupCostRecovery > 0 so
                  channels that don't opt in stay visually identical.
                  The chip's actuals reuse the same trailing6 fee bag as
                  the program pace so hitting stretch means we covered
                  underwritten salaries + profit + startup capital. */}
              {targets.startupCostRecovery > 0 && (
                <div
                  className="mt-4 rounded-xl bg-white/10 border border-white/20 px-4 py-3"
                  data-testid="team-stretch-chip"
                >
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <div className="text-white/70 text-[11px] uppercase tracking-wider font-medium">
                      Stretch total
                    </div>
                    <div className="text-white text-lg font-semibold font-variant-numeric-tabular">
                      {fmtUSD(targets.teamStretchRevenue)}
                    </div>
                    <div className="text-white/70 text-[12px]">
                      = <span className="text-white">{fmtUSD(targets.teamSixMonthRevenue)}</span>
                      {" program · "}
                      <span className="text-white">+{fmtUSD(targets.startupCostRecovery)}</span>
                      {" startup recovery"}
                    </div>
                    <div className="ml-auto text-right">
                      <div className="text-white/70 text-[11px] uppercase tracking-wider font-medium">
                        Monthly cadence
                      </div>
                      <div className="text-white text-[15px] font-semibold font-variant-numeric-tabular">
                        {fmtUSD(targets.teamStretchMonthly)}
                        <span className="text-white/60 font-normal text-[12px]">
                          {" · "}
                          {targets.teamStretchFloorPlacements} placements
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Per-recruiter split of the stretch tier. Salary-
                      proportional — recruiters carrying more monthly cost
                      also carry a bigger share of the startup-recovery
                      target. Hides itself when there are no recruiters
                      (empty configs) or when salaries aren't visible on
                      the non-admin projection (all-equal split would be
                      misleading, better to just say "see admin view"). */}
                  {targets.perRecruiter.length > 0 && targets.perRecruiter.every((r) => r.hasSalary) && (
                    <div className="mt-3 pt-3 border-t border-white/15">
                      <div className="text-white/70 text-[10px] uppercase tracking-wider font-medium mb-1.5">
                        Per recruiter
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {targets.perRecruiter.map((r) => (
                          <div
                            key={r.key}
                            className="inline-flex items-baseline gap-1.5 rounded-full bg-white/10 border border-white/15 px-2.5 py-1"
                            title={`${r.name}: ${fmtUSD(r.sixMonth)} program + ${fmtUSD(r.stretchExtra)} startup = ${fmtUSD(r.stretchTotalRevenue)} total`}
                            data-testid={`stretch-per-recruiter-${r.key}`}
                          >
                            <span className="text-white text-[12px] font-medium truncate max-w-[10rem]">
                              {r.name}
                            </span>
                            <span className="text-white text-[12px] font-semibold font-variant-numeric-tabular">
                              {fmtUSD(r.stretchTotalRevenue)}
                            </span>
                            <span className="text-white/60 text-[11px] font-variant-numeric-tabular">
                              (+{fmtUSD(r.stretchExtra)})
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>

          {/* Phase 2.6.2 — Leaderboard. Rendered only when the admin has
              picked a metric (leaderboardMetric != "off"). Keeps to a single
              scannable list: rank + name + primary metric. */}
          {display.leaderboardMetric && display.leaderboardMetric !== "off" && (
            <Leaderboard
              metric={display.leaderboardMetric}
              perRecruiter={targets.perRecruiter}
              actuals={actuals}
              currentMonth={currentMonth}
              monthElapsed={monthElapsed}
            />
          )}

          {/* Recruiter heat map — the "at a glance" visual sitting
              between the team card and the detailed recruiter cards.
              Each recruiter is a tile: color = pace vs the fixed
              program window, size = attainment fraction of that goal. */}
          <RecruiterHeatmap
            perRecruiter={targets.perRecruiter}
            programFeeByRecruiter={trailing6ByRecruiter}
            programFractionElapsed={programFractionElapsed}
            horizonMonths={horizonMonths}
            thresholds={config.thresholds}
          />

          {/* Per-recruiter cards. Each card is itself colorized so the
              roster reads as a heat map at a glance; the tile chart above
              provides the sized/color-mapped overview. */}
          <div>
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider font-medium text-[hsl(var(--vs-text-muted))] mb-3 px-1">
              <Users className="w-3.5 h-3.5" />
              Recruiter targets
            </div>
            <div className={gridClass}>
              {sortedPerRecruiter.map((r, i) => {
                const actual = currentMonthByRecruiter.get(r.key);
                const actualFee = (actual?.feeAmountCents ?? 0) / 100;
                const trailing6 = trailing6ByRecruiter.get(r.key) ?? { fee: 0, placements: 0 };
                // Monthly pace — kept ONLY for the small pace pill in the
                // card header so the MTD hero still has a fresh “how's
                // this month going” read. It no longer drives card color.
                const expectedByNow = r.monthly * monthElapsed;
                const pace = expectedByNow > 0 ? actualFee / expectedByNow : 0;
                // Program-horizon attainment vs goal — used for the
                // reference row's % note.
                const sixMonthAttainment = r.sixMonth > 0 ? trailing6.fee / r.sixMonth : 0;
                // Window pace = the only card colorization signal. Aligns
                // the per-recruiter card, the heat map tile, and the top
                // card on one consistent “where are they in the FIXED
                // program window” read.
                const windowExpected = r.sixMonth * programFractionElapsed;
                const windowPace = windowExpected > 0 ? trailing6.fee / windowExpected : 0;
                const windowHasActuals = trailing6.fee > 0;
                const heat = paceHeat(windowPace, windowHasActuals, config.thresholds);
                return (
                  <motion.div
                    key={r.key}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, delay: 0.03 * i }}
                    className={`relative overflow-hidden rounded-2xl bg-white dark:bg-[hsl(var(--vs-surface-elevated))] border border-[hsl(var(--vs-border))] ${cardPadClass} shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover-elevate transition`}
                    style={{
                      // Subtle background tint at ~5% opacity of the pace
                      // color so the card reads as “on pace” / “off track”
                      // without overwhelming the content.
                      backgroundImage: `linear-gradient(to right, ${heat.color}0D 0%, transparent 40%)`,
                    }}
                    data-testid={`recruiter-card-${r.key}`}
                  >
                    {/* Left-edge heat strip — 4px column of the window-pace color. */}
                    <div
                      className="absolute left-0 top-0 bottom-0 w-1"
                      style={{ background: heat.color, opacity: windowHasActuals ? 1 : 0.4 }}
                      aria-hidden
                    />
                    {/* Header: name + attainment pills.
                        MTD % = actual this month / monthly goal (raw, not pace-adjusted).
                        5-mo % = actual across program / program goal (raw).
                        Color signal is still window pace so the header still
                        reads as "on pace / behind / off track", but the numbers
                        are honest attainment fractions so a $2,550 placement
                        against a $12k monthly goal reads ~21%, not 116%. */}
                    <div className="flex items-start justify-between gap-3">
                      <div className={`font-display ${nameSizeClass} text-[hsl(var(--vs-text))] truncate`}>{r.name}</div>
                      <AttainmentPills
                        mtdFee={actualFee}
                        monthlyGoal={r.monthly}
                        programFee={trailing6.fee}
                        programGoal={r.sixMonth}
                        heatColor={heat.color}
                        hasActuals={windowHasActuals || actual != null}
                        horizonMonths={horizonMonths}
                      />
                    </div>

                    {/* Hero: actual performance — big + bright. This is the
                        primary answer to "where is this recruiter right now."
                        Both tiles are click-through: they open a popover
                        listing the underlying placements. */}
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <PlacementsPopover
                        channelId={channel.id}
                        recruiterKey={r.key}
                        recruiterName={r.name}
                        scope={{ kind: "month", periodMonth: currentMonth, label: `${currentMonth} placements` }}
                        canEdit={canEdit}
                      >
                        <button
                          type="button"
                          className="text-left w-full rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0090F0]/60"
                          data-testid={`hero-mtd-${r.key}`}
                        >
                          <ActualHeroStat
                            label="Actual MTD"
                            value={actual ? fmtUSD(actualFee) : "—"}
                            sub={actual ? `${actual.placementsCount} placement${actual.placementsCount === 1 ? "" : "s"}` : "No data"}
                            sizeClass={heroSizeClass}
                            dim={!actual}
                          />
                        </button>
                      </PlacementsPopover>
                      <PlacementsPopover
                        channelId={channel.id}
                        recruiterKey={r.key}
                        recruiterName={r.name}
                        scope={{ kind: "range", fromMonth: sixMoRange.from, toMonth: sixMoRange.to, label: `${horizonMonths}-month program` }}
                        canEdit={canEdit}
                      >
                        <button
                          type="button"
                          className="text-left w-full rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0090F0]/60"
                          data-testid={`hero-6mo-${r.key}`}
                        >
                          <ActualHeroStat
                            label={`Actual ${horizonMonths}-mo`}
                            value={trailing6.fee > 0 ? fmtUSD(trailing6.fee) : "—"}
                            sub={
                              trailing6.fee > 0
                                ? `${trailing6.placements} placement${trailing6.placements === 1 ? "" : "s"}${r.sixMonth > 0 ? ` · ${Math.round(sixMonthAttainment * 100)}% of goal` : ""}`
                                : "No data"
                            }
                            sizeClass={heroSizeClass}
                            dim={trailing6.fee <= 0}
                          />
                        </button>
                      </PlacementsPopover>
                    </div>

                    {/* Reference row: the goals live here now — smaller,
                        muted, clearly labelled as targets so eyes go to the
                        actuals above first.

                        When the startup-recovery tier is enabled, the third
                        slot shows the recruiter's combined program+startup
                        total (their share of the team stretch chip above)
                        and the sub-label calls out how much of that is the
                        startup slice. When the tier is off, we keep the
                        classic cadence-multiplier "Stretch" number. */}
                    <div className="mt-4 pt-3 border-t border-dashed border-[hsl(var(--vs-border))] grid grid-cols-3 gap-3">
                      <MiniStat label="Monthly goal" value={fmtUSD(r.monthly)} />
                      <MiniStat label={`${horizonMonths}-mo goal`} value={fmtUSD(r.sixMonth)} />
                      {targets.startupCostRecovery > 0 ? (
                        <MiniStat
                          label="Stretch total"
                          value={fmtUSD(r.stretchTotalRevenue)}
                          sub={`+${fmtUSD(r.stretchExtra)} startup`}
                        />
                      ) : (
                        <MiniStat label="Stretch" value={fmtUSD(r.stretch)} />
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>

          {/* Footer meta */}
          <div className="text-[11px] text-[hsl(var(--vs-text-muted))] px-1 pt-2">
            Growth focus: non-IFS / non-QUES accounts. Green ≥ {Math.round(config.thresholds.green * 100)}% of pace ·
            Yellow ≥ {Math.round(config.thresholds.yellow * 100)}% · Red below.
          </div>
        </div>
      </div>

      {editOpen && (
        <EditConfigDialog
          channelId={channel.id}
          config={config}
          onClose={() => setEditOpen(false)}
        />
      )}
      {logOpen && (
        <LogActualsDialog
          channelId={channel.id}
          config={config}
          actuals={actuals}
          onClose={() => setLogOpen(false)}
        />
      )}
      {emailOpen && (
        <EmailScorecardDialog
          channelId={channel.id}
          channelName={channel.name}
          onClose={() => setEmailOpen(false)}
        />
      )}
    </div>
  );
}

/* ─────────────────── small pieces ─────────────────── */

/**
 * Phase 2.6.2 — Leaderboard panel.
 *
 * Deliberately minimal: rank + name + one number. Metric chosen by admin
 * via the Display section. Non-admin viewers see the same panel because
 * every underlying signal (actuals, monthly target, 3mo fee) is already
 * present on the projected ScorecardResponse.
 */
function Leaderboard({
  metric,
  perRecruiter,
  actuals,
  currentMonth,
  monthElapsed,
}: {
  metric: "mtd-fee" | "pace" | "rolling-3mo-fee";
  perRecruiter: Array<{ key: string; name: string; monthly: number }>;
  actuals: Actual[];
  currentMonth: string;
  monthElapsed: number;
}) {
  const rolling3 = new Set(recentMonths(3));
  const byRecruiter = new Map<string, { mtdFee: number; rollingFee: number }>();
  for (const a of actuals) {
    const fee = (a.feeAmountCents ?? 0) / 100;
    const entry = byRecruiter.get(a.recruiterKey) ?? { mtdFee: 0, rollingFee: 0 };
    if (a.periodMonth === currentMonth) entry.mtdFee += fee;
    if (rolling3.has(a.periodMonth)) entry.rollingFee += fee;
    byRecruiter.set(a.recruiterKey, entry);
  }

  const rows = perRecruiter.map((r) => {
    const b = byRecruiter.get(r.key) ?? { mtdFee: 0, rollingFee: 0 };
    // Pace = MTD fee / pro-rated monthly target. Recruiters with no monthly
    // target sort last (rank -Infinity).
    const pace = r.monthly > 0 ? b.mtdFee / (r.monthly * Math.max(monthElapsed, 0.01)) : -Infinity;
    let value = 0;
    if (metric === "mtd-fee") value = b.mtdFee;
    else if (metric === "rolling-3mo-fee") value = b.rollingFee;
    else value = pace;
    return { key: r.key, name: r.name, value };
  });
  rows.sort((a, b) => b.value - a.value);

  const label =
    metric === "mtd-fee" ? "MTD Fees"
    : metric === "pace" ? "Pace vs. Target"
    : "Rolling 3-Month Fees";

  const fmt = (v: number) => {
    if (!Number.isFinite(v)) return "—";
    if (metric === "pace") return `${Math.round(v * 100)}%`;
    return `$${Math.round(v).toLocaleString()}`;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="rounded-2xl bg-gradient-to-br from-[#0090F0]/[0.04] to-transparent border border-[hsl(var(--vs-border))] p-4 md:p-5 mb-4"
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider font-medium text-[hsl(var(--vs-text-muted))] mb-3">
        <Trophy className="w-3.5 h-3.5 text-[#0090F0]" />
        Leaderboard — {label}
      </div>
      <ol className="divide-y divide-[hsl(var(--vs-border))]">
        {rows.map((row, i) => (
          <li key={row.key} className="flex items-center gap-3 py-2">
            <div
              className={
                "w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-[12px] font-semibold tabular-nums " +
                (i === 0
                  ? "bg-[#0090F0] text-white"
                  : i === 1
                  ? "bg-[#0090F0]/25 text-[hsl(var(--vs-text))]"
                  : i === 2
                  ? "bg-[#0090F0]/15 text-[hsl(var(--vs-text))]"
                  : "bg-[hsl(var(--vs-surface))] text-[hsl(var(--vs-text-muted))] border border-[hsl(var(--vs-border))]")
              }
            >
              {i + 1}
            </div>
            <div className="flex-1 min-w-0 text-sm text-[hsl(var(--vs-text))] truncate">{row.name}</div>
            <div className="text-sm font-display tabular-nums text-[hsl(var(--vs-text))]">{fmt(row.value)}</div>
          </li>
        ))}
      </ol>
    </motion.div>
  );
}

function SummaryStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-white/70 text-[11px] uppercase tracking-wider font-medium">{label}</div>
      <div className="mt-1 text-[22px] md:text-[26px] font-display tabular-nums text-white">{value}</div>
      {sub && <div className="text-white/60 text-[11px] mt-0.5">{sub}</div>}
    </div>
  );
}

/**
 * Big number tile used for the two hero targets on each recruiter card
 * (This Month + 6-Month). Kept visually distinct from MiniStat so the pair
 * reads as "the two important numbers" at a glance.
 */
function HeroStat({ label, value, sizeClass = "text-[20px]" }: { label: string; value: string; sizeClass?: string }) {
  return (
    <div className="rounded-xl bg-[hsl(var(--vs-surface))]/50 border border-[hsl(var(--vs-border))] px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider font-medium text-[hsl(var(--vs-text-muted))]">
        {label}
      </div>
      <div className={`mt-1 font-display ${sizeClass} leading-tight tabular-nums text-[hsl(var(--vs-text))]`}>
        {value}
      </div>
    </div>
  );
}

/**
 * The bigger, brighter hero used for actuals (MTD + program-window). Wrapped in
 * a filled blue chip so the eye lands here first — goals live in the muted
 * reference row below the card body.
 *
 * When `dim=true` the chip renders in a neutral tone ("No data yet") so an
 * empty recruiter doesn't shout an accidental $0 in bright brand blue.
 */
function ActualHeroStat({
  label,
  value,
  sub,
  sizeClass = "text-[20px]",
  dim = false,
}: {
  label: string;
  value: string;
  sub?: string;
  sizeClass?: string;
  dim?: boolean;
}) {
  return (
    <div
      className={
        dim
          ? "rounded-xl bg-[hsl(var(--vs-surface))]/70 border border-[hsl(var(--vs-border))] px-3 py-3"
          : "rounded-xl bg-gradient-to-br from-[#0090F0] to-[#0064B8] text-white px-3 py-3 shadow-[0_4px_14px_-6px_rgba(0,100,184,0.55)]"
      }
    >
      <div
        className={
          dim
            ? "text-[10px] uppercase tracking-wider font-medium text-[hsl(var(--vs-text-muted))]"
            : "text-[10px] uppercase tracking-wider font-semibold text-white/85"
        }
      >
        {label}
      </div>
      <div
        className={`mt-1 font-display ${sizeClass} leading-tight tabular-nums ${dim ? "text-[hsl(var(--vs-text-muted))]" : "text-white"}`}
      >
        {value}
      </div>
      {sub && (
        <div className={`mt-1 text-[11px] tabular-nums ${dim ? "text-[hsl(var(--vs-text-muted))]" : "text-white/80"}`}>
          {sub}
        </div>
      )}
    </div>
  );
}


/**
 * Popover that lists individual placements underlying a hero stat. Fires
 * a fetch only when opened (React Query with `enabled: open`). Deletable
 * rows if the caller has edit rights.
 */
function PlacementsPopover({
  channelId,
  recruiterKey,
  recruiterName,
  scope,
  canEdit,
  children,
}: {
  channelId: number;
  recruiterKey: string;
  recruiterName: string;
  scope:
    | { kind: "month"; periodMonth: string; label: string }
    | { kind: "range"; fromMonth: string; toMonth: string; label: string };
  canEdit: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  const query = useQuery<{ placements: Placement[] }>({
    queryKey: [
      "/api/channels",
      channelId,
      "scorecard",
      "placements",
      recruiterKey,
      scope.kind === "month" ? scope.periodMonth : `${scope.fromMonth}..${scope.toMonth}`,
    ],
    queryFn: async () => {
      const params = new URLSearchParams({ recruiterKey });
      if (scope.kind === "month") {
        params.set("periodMonth", scope.periodMonth);
      } else {
        params.set("fromMonth", scope.fromMonth);
        params.set("toMonth", scope.toMonth);
      }
      const res = await apiRequest("GET", `/api/channels/${channelId}/scorecard/placements?${params.toString()}`);
      return res as { placements: Placement[] };
    },
    enabled: open,
    staleTime: 10_000,
  });

  const del = useMutation({
    mutationFn: async (placementId: number) => {
      return apiRequest("DELETE", `/api/channels/${channelId}/scorecard/placements/${placementId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channelId, "scorecard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channelId, "scorecard", "placements"] });
      toast({ title: "Placement deleted" });
    },
    onError: (e: any) => {
      toast({
        title: "Delete failed",
        description: e?.body?.message ?? e?.message ?? "Try again.",
        variant: "destructive",
      });
    },
  });

  const placements = query.data?.placements ?? [];
  const totalFee = placements.reduce((s, p) => s + p.feeAmountCents, 0) / 100;

  // Combined interaction model: click/tap opens (works on all devices,
  // required for the touch UX the user asked for), plus hover-to-open
  // and hover-out-to-close on pointer devices so desktop keeps the
  // "just move your mouse over the number" affordance. We manage `open`
  // ourselves so both paths write to the same state.
  const hoverTimer = useMemo(() => ({ current: null as ReturnType<typeof setTimeout> | null }), []);
  const openOnHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setOpen(true), 120);
  };
  const closeOnHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setOpen(false), 160);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={openOnHover}
          onMouseLeave={closeOnHover}
          className="block text-left w-full cursor-pointer rounded-xl focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-[#0090F0]"
          aria-label={`Show ${scope.label.toLowerCase()} placements for ${recruiterName}`}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        onMouseEnter={openOnHover}
        onMouseLeave={closeOnHover}
        className="w-[380px] max-w-[calc(100vw-32px)] p-0 bg-white dark:bg-[hsl(var(--vs-surface-elevated))] border-[hsl(var(--vs-border))]"
      >
        <div className="px-3 py-2.5 border-b border-[hsl(var(--vs-border))] flex items-start justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wider font-medium text-[hsl(var(--vs-text-muted))]">
              {recruiterName} · {scope.label}
            </div>
            <div className="font-display text-[16px] leading-tight text-[hsl(var(--vs-text))] tabular-nums mt-0.5">
              {placements.length > 0 ? fmtUSD(totalFee) : "—"}
              <span className="ml-2 text-[11px] font-normal text-[hsl(var(--vs-text-muted))]">
                {placements.length} placement{placements.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="h-6 w-6 rounded-full inline-flex items-center justify-center text-[hsl(var(--vs-text-muted))] hover-elevate"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="max-h-[280px] overflow-y-auto">
          {query.isLoading && (
            <div className="px-3 py-6 text-center text-[12px] text-[hsl(var(--vs-text-muted))] inline-flex items-center justify-center gap-2 w-full">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading placements…
            </div>
          )}
          {!query.isLoading && placements.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-[hsl(var(--vs-text-muted))]">
              No detailed placements yet. Log placements individually to see them here.
            </div>
          )}
          {!query.isLoading && placements.length > 0 && (
            <ul className="divide-y divide-[hsl(var(--vs-border))]/60">
              {placements.map((p) => (
                <li key={p.id} className="px-3 py-2 flex items-start justify-between gap-2 text-[12px]">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums text-[hsl(var(--vs-text-muted))]">{p.placedAt}</span>
                      <span className="font-medium tabular-nums text-[hsl(var(--vs-text))]">
                        {fmtUSD(p.feeAmountCents / 100)}
                      </span>
                    </div>
                    {(p.candidateName || p.clientName) && (
                      <div className="mt-0.5 text-[11px] text-[hsl(var(--vs-text))] truncate">
                        {p.candidateName ?? "—"}
                        {p.clientName && (
                          <span className="text-[hsl(var(--vs-text-muted))]"> · {p.clientName}</span>
                        )}
                      </div>
                    )}
                    {p.notes && (
                      <div className="mt-0.5 text-[11px] text-[hsl(var(--vs-text-muted))] truncate">
                        {p.notes}
                      </div>
                    )}
                  </div>
                  {canEdit && (
                    <button
                      type="button"
                      className="h-6 w-6 rounded-full inline-flex items-center justify-center text-[hsl(var(--vs-text-muted))] hover:text-[#ef4444] hover-elevate disabled:opacity-40"
                      onClick={() => {
                        if (window.confirm("Delete this placement?")) del.mutate(p.id);
                      }}
                      disabled={del.isPending}
                      aria-label="Delete placement"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MiniStat({
  label,
  value,
  accent,
  sub,
}: {
  label: string;
  value: string;
  accent?: boolean;
  /** Optional muted supporting line under the value (e.g. "+$100k startup"). */
  sub?: string;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-medium text-[hsl(var(--vs-text-muted))]">{label}</div>
      <div
        className={`mt-0.5 text-[13px] tabular-nums ${
          accent ? "text-[#0090F0] font-medium" : "text-[hsl(var(--vs-text))]"
        }`}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 text-[10px] tabular-nums text-[hsl(var(--vs-text-muted))]">
          {sub}
        </div>
      )}
    </div>
  );
}

/**
 * Two small pills — MTD % and program % — shown in each recruiter card
 * header. Both are RAW attainment (actual / goal), not pace-adjusted.
 *
 * Rationale: the old single "pace" pill showed actual / (goal * fraction-of-
 * period-elapsed). That's a legitimate signal but visually confusing: a
 * recruiter at 4% of a 5-month goal on day 6 of month 1 reads as 116%
 * pace even though they've only captured 4% of their target. Splitting into
 * MTD and program attainment makes both numbers reconcile 1:1 with the hero
 * values below ("$2,550 · 4% of goal").
 *
 * Color still comes from window pace (heatColor prop) so the header keeps
 * the same red/amber/green semantics the rest of the card uses.
 */
function AttainmentPills({
  mtdFee,
  monthlyGoal,
  programFee,
  programGoal,
  heatColor,
  hasActuals,
  horizonMonths,
}: {
  mtdFee: number;
  monthlyGoal: number;
  programFee: number;
  programGoal: number;
  heatColor: string;
  hasActuals: boolean;
  horizonMonths: number;
}) {
  if (!hasActuals) {
    return (
      <div className="text-[10px] uppercase tracking-wider font-medium px-2 py-0.5 rounded-full bg-[hsl(var(--vs-surface))] text-[hsl(var(--vs-text-muted))] border border-[hsl(var(--vs-border))]">
        No data
      </div>
    );
  }
  const mtdPct = monthlyGoal > 0 ? Math.round((mtdFee / monthlyGoal) * 100) : 0;
  const programPct = programGoal > 0 ? Math.round((programFee / programGoal) * 100) : 0;
  // Tint the pill background/text with the same pace color used by the
  // left-edge strip so the header reads consistently with the rest of the
  // card. Using inline styles because the color comes from a data-driven
  // paceHeat lookup, not a fixed Tailwind class.
  const pillStyle = {
    background: `${heatColor}26`, // ~15% alpha
    color: heatColor,
    boxShadow: `inset 0 0 0 1px ${heatColor}33`, // ~20% alpha ring
  } as const;
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <div
        className="text-[10px] font-semibold tabular-nums px-2 py-0.5 rounded-full inline-flex items-baseline gap-1"
        style={pillStyle}
        title={`Month-to-date: ${fmtUSD(mtdFee)} of ${fmtUSD(monthlyGoal)} monthly goal`}
      >
        <span className="text-[8px] uppercase tracking-wider opacity-80">MTD</span>
        <span>{mtdPct}%</span>
      </div>
      <div
        className="text-[10px] font-semibold tabular-nums px-2 py-0.5 rounded-full inline-flex items-baseline gap-1"
        style={pillStyle}
        title={`${horizonMonths}-month program: ${fmtUSD(programFee)} of ${fmtUSD(programGoal)} goal`}
      >
        <span className="text-[8px] uppercase tracking-wider opacity-80">{horizonMonths}MO</span>
        <span>{programPct}%</span>
      </div>
    </div>
  );
}

function PacePill({
  pace,
  thresholds,
  hasActuals,
}: {
  pace: number;
  thresholds: { green: number; yellow: number };
  hasActuals: boolean;
}) {
  if (!hasActuals) {
    return (
      <div className="text-[10px] uppercase tracking-wider font-medium px-2 py-0.5 rounded-full bg-[hsl(var(--vs-surface))] text-[hsl(var(--vs-text-muted))] border border-[hsl(var(--vs-border))]">
        No data
      </div>
    );
  }
  const isGreen = pace >= thresholds.green;
  const isYellow = !isGreen && pace >= thresholds.yellow;
  const bg = isGreen
    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-emerald-500/20"
    : isYellow
      ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-amber-500/20"
      : "bg-red-500/15 text-red-600 dark:text-red-400 ring-red-500/20";
  return (
    <div className={`text-[10px] font-semibold tabular-nums px-2 py-0.5 rounded-full ring-1 ${bg}`}>
      {Math.round(pace * 100)}%
    </div>
  );
}

/* ─────────────────── edit-config dialog ─────────────────── */

function EditConfigDialog({
  channelId,
  config,
  onClose,
}: {
  channelId: number;
  config: ScorecardConfig;
  onClose: () => void;
}) {
  const { toast } = useToast();
  // If we opened this dialog as an admin, the config should include salaries.
  // Non-admins shouldn't be able to open it (button is gated), but we render
  // defensively — a null salary just shows blank.
  const [averageFee, setAverageFee] = useState(String(config.averageFee));
  const [profitPct, setProfitPct] = useState(String(Math.round(config.profitTarget * 100)));
  const [stretchMul, setStretchMul] = useState(config.stretchMultiplier.toFixed(2));
  // Fixed forward program window — defaults to VTS Aug→Dec 2026 for
  // pre-existing configs that don't have these fields yet.
  const [programStartMonth, setProgramStartMonth] = useState(
    config.programStartMonth ?? DEFAULT_PROGRAM_START_MONTH,
  );
  const [programHorizonMonths, setProgramHorizonMonths] = useState(
    String(config.programHorizonMonths ?? DEFAULT_PROGRAM_HORIZON_MONTHS),
  );
  const [fundingHorizonMonths, setFundingHorizonMonths] = useState(
    String(config.fundingHorizonMonths ?? DEFAULT_FUNDING_HORIZON_MONTHS),
  );
  const [rows, setRows] = useState(
    config.recruiters.map((r) => ({ key: r.key, name: r.name, salary: r.monthlySalary != null ? String(r.monthlySalary) : "" })),
  );
  // Phase 2.6.1 — display presets. Fall back to defaults so a config saved
  // before this dialog knew about `display` doesn't lose values on save.
  const [preset, setPreset] = useState<"compact" | "comfortable" | "spacious">(
    config.display?.preset ?? "comfortable",
  );
  const [density, setDensity] = useState<"1-col" | "2-col" | "3-col">(
    config.display?.density ?? "3-col",
  );
  const [sortBy, setSortBy] = useState<"name" | "pace-desc" | "pace-asc" | "actual-mtd-desc">(
    config.display?.sortBy ?? "name",
  );
  const [leaderboardMetric, setLeaderboardMetric] = useState<
    "off" | "mtd-fee" | "pace" | "rolling-3mo-fee"
  >(config.display?.leaderboardMetric ?? "off");

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        averageFee: Number(averageFee),
        profitTarget: Number(profitPct) / 100,
        stretchMultiplier: Number(stretchMul),
        thresholds: config.thresholds,
        recruiters: rows.map((r) => ({
          key: r.key.trim() || r.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          name: r.name.trim(),
          monthlySalary: Number(r.salary || 0),
        })),
        display: { preset, density, sortBy, leaderboardMetric },
        // Program window — sent explicitly so admins can shift the
        // fixed forward horizon (e.g. next year's Aug→Dec run) without
        // a code change. Zod re-applies defaults if either is missing.
        programStartMonth: programStartMonth.trim() || DEFAULT_PROGRAM_START_MONTH,
        programHorizonMonths: Number(programHorizonMonths) || DEFAULT_PROGRAM_HORIZON_MONTHS,
        fundingHorizonMonths: Number(fundingHorizonMonths) || DEFAULT_FUNDING_HORIZON_MONTHS,
      };
      return apiRequest("PATCH", `/api/channels/${channelId}/scorecard/config`, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channelId, "scorecard"] });
      toast({ title: "Scorecard updated" });
      onClose();
    },
    onError: (e: any) => {
      toast({ title: "Save failed", description: e?.body?.message ?? e?.message ?? "Try again.", variant: "destructive" });
    },
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      {/* Wider dialog (max-w-2xl) + capped height with scroll so the recruiter
          rows never crowd the salary column or push the Save button off
          screen on small viewports. Fixes the wrapping/clipping issue where
          the 3-column recruiter row + × button overflowed max-w-lg. */}
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit scorecard</DialogTitle>
          <DialogDescription>Recruiters, salaries, and targets. Salaries stay private — only admins see them.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-3">
          <LabeledInput label="Avg fee ($)" value={averageFee} onChange={setAverageFee} />
          <LabeledInput label="Profit %" value={profitPct} onChange={setProfitPct} />
          <LabeledInput label="Stretch ×" value={stretchMul} onChange={setStretchMul} />
        </div>
        {/* Fixed forward program window + funding horizon.

            Program horizon = how long the program actually runs (drives
            monthly cadence). Funding horizon = how the salaries were
            underwritten (drives the total revenue target). VTS: funding
            6, program 5, so the 6-month goal must be delivered in 5
            months — monthly targets scale up ~20% to compensate.

            Set funding = program to get pro-rata behavior. */}
        <div className="mt-3 grid grid-cols-3 gap-3">
          <LabeledInput
            label="Program start (YYYY-MM)"
            value={programStartMonth}
            onChange={setProgramStartMonth}
          />
          <LabeledInput
            label="Program horizon (months)"
            value={programHorizonMonths}
            onChange={setProgramHorizonMonths}
          />
          <LabeledInput
            label="Funding horizon (months)"
            value={fundingHorizonMonths}
            onChange={setFundingHorizonMonths}
          />
        </div>
        <div className="mt-1 text-[11px] text-[hsl(var(--vs-text-muted))]">
          Total revenue target = monthly salary × <b>funding</b> horizon / (1 − profit).
          Monthly target = total ÷ <b>program</b> horizon.
        </div>
        <div className="mt-2 space-y-2">
          <div className="text-[11px] uppercase tracking-wider font-medium text-[hsl(var(--vs-text-muted))]">
            Recruiters
          </div>
          {rows.map((r, idx) => (
            <div key={idx} className="grid grid-cols-[120px_1fr_140px_36px] gap-2 items-center">
              <input
                className="h-9 px-2 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] text-sm"
                placeholder="key"
                value={r.key}
                onChange={(e) => setRows((rs) => rs.map((row, i) => (i === idx ? { ...row, key: e.target.value } : row)))}
              />
              <input
                className="h-9 px-2 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] text-sm"
                placeholder="Name"
                value={r.name}
                onChange={(e) => setRows((rs) => rs.map((row, i) => (i === idx ? { ...row, name: e.target.value } : row)))}
              />
              <input
                className="h-9 px-2 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] text-sm tabular-nums"
                placeholder="Salary $"
                value={r.salary}
                onChange={(e) => setRows((rs) => rs.map((row, i) => (i === idx ? { ...row, salary: e.target.value } : row)))}
              />
              <button
                type="button"
                className="h-9 w-9 rounded-md text-[hsl(var(--vs-text-muted))] hover:text-red-500 hover-elevate"
                title="Remove"
                onClick={() => setRows((rs) => rs.filter((_, i) => i !== idx))}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="mt-1 h-8 px-3 rounded-full text-[12px] font-medium bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] hover-elevate"
            onClick={() =>
              setRows((rs) => [...rs, { key: `new-${rs.length + 1}`, name: "", salary: "" }])
            }
          >
            + Add recruiter
          </button>
        </div>
        {/* Phase 2.6.1 — Display presets. Three curated knobs that change
            how everyone sees the widget. Kept small on purpose so this stays
            a couple of dropdowns, not a settings kitchen sink. */}
        <div className="mt-4 pt-4 border-t border-[hsl(var(--vs-border))]">
          <div className="text-[11px] uppercase tracking-wider font-medium text-[hsl(var(--vs-text-muted))] mb-2">
            Display
          </div>
          <div className="grid grid-cols-3 gap-3">
            <LabeledSelect
              label="Preset"
              value={preset}
              onChange={(v) => setPreset(v as any)}
              options={[
                { value: "compact", label: "Compact" },
                { value: "comfortable", label: "Comfortable" },
                { value: "spacious", label: "Spacious" },
              ]}
            />
            <LabeledSelect
              label="Density"
              value={density}
              onChange={(v) => setDensity(v as any)}
              options={[
                { value: "1-col", label: "1 per row" },
                { value: "2-col", label: "2 per row" },
                { value: "3-col", label: "3 per row" },
              ]}
            />
            <LabeledSelect
              label="Sort by"
              value={sortBy}
              onChange={(v) => setSortBy(v as any)}
              options={[
                { value: "name", label: "Name" },
                { value: "pace-desc", label: "Pace ↓" },
                { value: "pace-asc", label: "Pace ↑" },
                { value: "actual-mtd-desc", label: "MTD $ ↓" },
              ]}
            />
          </div>
          {/* Leaderboard sits on its own row so the label + explanation
              have room and the dropdown can be full-width. Off by default. */}
          <div className="mt-3">
            <LabeledSelect
              label="Leaderboard"
              value={leaderboardMetric}
              onChange={(v) => setLeaderboardMetric(v as any)}
              options={[
                { value: "off", label: "Off" },
                { value: "mtd-fee", label: "MTD Fees ($ closed this month)" },
                { value: "pace", label: "Pace vs. Target (% of month’s goal)" },
                { value: "rolling-3mo-fee", label: "Rolling 3-Month Fees" },
              ]}
            />
          </div>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className="h-9 px-4 rounded-full text-[13px] text-[hsl(var(--vs-text-muted))] hover-elevate"
            onClick={onClose}
            disabled={save.isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="h-9 px-5 rounded-full text-[13px] font-medium bg-[#0090F0] text-white hover:bg-[#0080D8] active:scale-[0.98] transition disabled:opacity-60"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────── log-actuals dialog ─────────────────── */

/**
 * Per-placement entry dialog. Defaults to a single-row form so the common
 * case (“I just made one placement”) is a fast 5-second entry, then a
 * discreet “+ Add another” button expands into a multi-row batch.
 *
 * Each row is a full placement record (recruiter, date, candidate, client,
 * fee, notes). Submission POSTs the batch to the placements endpoint; the
 * server derives periodMonth from placedAt and reconciles the aggregate.
 */
type PlacementDraft = {
  id: string; // client-side row key
  recruiterKey: string;
  placedAt: string; // "YYYY-MM-DD"
  candidateName: string;
  clientName: string;
  feeAmount: string; // dollars, string for input state
  notes: string;
};

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function newDraft(defaultRecruiterKey: string): PlacementDraft {
  return {
    id: `d_${Math.random().toString(36).slice(2, 9)}`,
    recruiterKey: defaultRecruiterKey,
    placedAt: todayISO(),
    candidateName: "",
    clientName: "",
    feeAmount: "",
    notes: "",
  };
}

function LogActualsDialog({
  channelId,
  config,
  onClose,
}: {
  channelId: number;
  config: ScorecardConfig;
  actuals: Actual[]; // kept in the type for API compatibility; no longer used
  onClose: () => void;
}) {
  const { toast } = useToast();
  const defaultRecruiterKey = config.recruiters[0]?.key ?? "";
  const [drafts, setDrafts] = useState<PlacementDraft[]>(() => [newDraft(defaultRecruiterKey)]);

  const totalFee = drafts.reduce((s, d) => s + (Number(d.feeAmount) || 0), 0);

  const updateDraft = (id: string, patch: Partial<PlacementDraft>) => {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };
  const removeDraft = (id: string) => {
    setDrafts((prev) => (prev.length <= 1 ? prev : prev.filter((d) => d.id !== id)));
  };
  const addDraft = () => {
    // Inherit the most recently used recruiter + date so batch entry feels
    // like a natural continuation of the previous row.
    const last = drafts[drafts.length - 1];
    setDrafts((prev) => [
      ...prev,
      {
        ...newDraft(last?.recruiterKey ?? defaultRecruiterKey),
        placedAt: last?.placedAt ?? todayISO(),
      },
    ]);
  };

  const submit = useMutation({
    mutationFn: async () => {
      const placements = drafts.map((d) => ({
        recruiterKey: d.recruiterKey,
        placedAt: d.placedAt,
        candidateName: d.candidateName.trim() || null,
        clientName: d.clientName.trim() || null,
        feeAmountCents: Math.max(0, Math.round((Number(d.feeAmount) || 0) * 100)),
        notes: d.notes.trim() || null,
      }));
      return apiRequest("POST", `/api/channels/${channelId}/scorecard/placements`, { placements });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channelId, "scorecard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channelId, "scorecard", "placements"] });
      toast({
        title: drafts.length === 1 ? "Placement logged" : `${drafts.length} placements logged`,
        description: totalFee > 0 ? `Total: ${fmtUSD(totalFee)}` : undefined,
      });
      onClose();
    },
    onError: (e: any) => {
      toast({
        title: "Save failed",
        description: e?.body?.message ?? e?.message ?? "Try again.",
        variant: "destructive",
      });
    },
  });

  // Block submit if any row is missing a fee or date. Recruiter defaults to
  // the first configured recruiter, so an empty recruiter key means the
  // config has no recruiters yet — also block.
  const canSubmit =
    drafts.length > 0 &&
    drafts.every((d) => d.recruiterKey && d.placedAt && (Number(d.feeAmount) || 0) >= 0) &&
    drafts.some((d) => (Number(d.feeAmount) || 0) > 0 || d.candidateName.trim() || d.clientName.trim());

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Log placement{drafts.length === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>
            One row per placement. Add another row to log multiple placements in a single save.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2.5 max-h-[60vh] overflow-y-auto pr-1">
          {drafts.map((d, idx) => (
            <div
              key={d.id}
              className="rounded-xl border border-[hsl(var(--vs-border))] bg-[hsl(var(--vs-surface))]/40 p-3"
              data-testid={`placement-row-${idx}`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-[hsl(var(--vs-text-muted))]">
                  Placement {idx + 1}
                </div>
                {drafts.length > 1 && (
                  <button
                    type="button"
                    className="h-6 w-6 rounded-full inline-flex items-center justify-center text-[hsl(var(--vs-text-muted))] hover:text-[#ef4444] hover-elevate"
                    onClick={() => removeDraft(d.id)}
                    aria-label="Remove placement"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-[hsl(var(--vs-text-muted))] mb-1">
                    Recruiter
                  </div>
                  <select
                    className="w-full h-9 px-2 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] text-sm"
                    value={d.recruiterKey}
                    onChange={(e) => updateDraft(d.id, { recruiterKey: e.target.value })}
                  >
                    {config.recruiters.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-[hsl(var(--vs-text-muted))] mb-1">
                    Date
                  </div>
                  <input
                    type="date"
                    className="w-full h-9 px-2 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] text-sm tabular-nums"
                    value={d.placedAt}
                    onChange={(e) => updateDraft(d.id, { placedAt: e.target.value })}
                  />
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-[hsl(var(--vs-text-muted))] mb-1">
                    Candidate
                  </div>
                  <input
                    type="text"
                    className="w-full h-9 px-2 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] text-sm"
                    value={d.candidateName}
                    placeholder="Name"
                    onChange={(e) => updateDraft(d.id, { candidateName: e.target.value })}
                    maxLength={120}
                  />
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-[hsl(var(--vs-text-muted))] mb-1">
                    Client
                  </div>
                  <input
                    type="text"
                    className="w-full h-9 px-2 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] text-sm"
                    value={d.clientName}
                    placeholder="Company"
                    onChange={(e) => updateDraft(d.id, { clientName: e.target.value })}
                    maxLength={120}
                  />
                </div>
                <div className="sm:col-span-2">
                  <div className="text-[11px] uppercase tracking-wider text-[hsl(var(--vs-text-muted))] mb-1">
                    Fee ($)
                  </div>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    className="w-full h-9 px-2 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] text-sm tabular-nums"
                    value={d.feeAmount}
                    placeholder="0.00"
                    onChange={(e) => updateDraft(d.id, { feeAmount: e.target.value })}
                  />
                </div>
                <div className="sm:col-span-2">
                  <div className="text-[11px] uppercase tracking-wider text-[hsl(var(--vs-text-muted))] mb-1">
                    Notes (optional)
                  </div>
                  <input
                    type="text"
                    className="w-full h-9 px-2 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] text-sm"
                    value={d.notes}
                    placeholder="e.g. contract-to-hire, referral"
                    onChange={(e) => updateDraft(d.id, { notes: e.target.value })}
                    maxLength={500}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={addDraft}
            disabled={submit.isPending || drafts.length >= 50}
            className="h-9 px-3 rounded-full text-[13px] font-medium text-[#0090F0] hover:bg-[#0090F0]/10 inline-flex items-center gap-1.5 disabled:opacity-40"
            data-testid="add-another-placement"
          >
            <Plus className="w-3.5 h-3.5" />
            Add another
          </button>
          <div className="text-[11px] tabular-nums text-[hsl(var(--vs-text-muted))]">
            {drafts.length} row{drafts.length === 1 ? "" : "s"} · Total {fmtUSD(totalFee)}
          </div>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className="h-9 px-4 rounded-full text-[13px] text-[hsl(var(--vs-text-muted))] hover-elevate"
            onClick={onClose}
            disabled={submit.isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => submit.mutate()}
            disabled={!canSubmit || submit.isPending}
            className="h-9 px-5 rounded-full text-[13px] font-medium bg-[#0090F0] text-white hover:bg-[#0080D8] active:scale-[0.98] transition disabled:opacity-60"
            data-testid="save-placements"
          >
            {submit.isPending ? "Saving…" : `Save ${drafts.length === 1 ? "placement" : `${drafts.length} placements`}`}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LabeledInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-[hsl(var(--vs-text-muted))] mb-1">{label}</div>
      <input
        className="w-full h-9 px-2 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] text-sm tabular-nums"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
      />
    </div>
  );
}

/**
 * Native <select> styled to match LabeledInput. Used by the Display
 * presets in EditConfigDialog. Kept minimal on purpose — shadcn's Select
 * is overkill for a 3-option enum.
 */
function LabeledSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-[hsl(var(--vs-text-muted))] mb-1">{label}</div>
      <select
        className="w-full h-9 px-2 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

/**
 * EmailScorecardDialog — collects recipients + optional subject/note and
 * posts to the server, which renders a text+HTML snapshot of the current
 * scorecard state and sends it via SendGrid. The client intentionally does
 * NOT capture DOM to an image or bundle a PDF attachment; the server
 * re-computes the same targets/actuals from the DB so the email stays in
 * sync with what any recipient would see on refresh, and so the email is
 * generated from the server's authoritative snapshot rather than whatever
 * the sender happens to have on screen.
 *
 * UX contract:
 *   • Recipients entered as chips (comma/enter/blur commits an email).
 *     Invalid entries are shown inline and blocked at submit.
 *   • Subject defaults to “{channelName} — scorecard update”; user can edit.
 *   • Optional freeform note — prepended above the auto-rendered summary.
 *   • On success, toast lists how many recipients were mailed; on any per-
 *     recipient failure the server returns partial success and we surface
 *     the failures without closing the dialog.
 */
function EmailScorecardDialog({
  channelId,
  channelName,
  onClose,
}: {
  channelId: number;
  channelName: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [chips, setChips] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [subject, setSubject] = useState(`${channelName} — scorecard update`);
  const [note, setNote] = useState("");

  // Minimal RFC-shaped email check. Server re-validates; this is only for
  // preventing the user from mailing typos like "josh@" or trailing commas.
  const isEmailLike = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

  const commitDraft = () => {
    const parts = draft.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return;
    setChips((prev) => {
      const seen = new Set(prev.map((c) => c.toLowerCase()));
      const next = [...prev];
      for (const p of parts) {
        const key = p.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          next.push(p);
        }
      }
      return next;
    });
    setDraft("");
  };

  const removeChip = (idx: number) => {
    setChips((prev) => prev.filter((_, i) => i !== idx));
  };

  const invalidChips = chips.filter((c) => !isEmailLike(c));
  const canSubmit = chips.length > 0 && invalidChips.length === 0 && subject.trim().length > 0;

  const submit = useMutation({
    mutationFn: async () => {
      const payload = {
        recipients: chips,
        subject: subject.trim(),
        note: note.trim() || null,
      };
      const res: any = await apiRequest("POST", `/api/channels/${channelId}/scorecard/email`, payload);
      return res;
    },
    onSuccess: (res: any) => {
      const sent: string[] = res?.sent ?? [];
      const failed: Array<{ email: string; reason: string }> = res?.failed ?? [];
      if (failed.length === 0) {
        toast({
          title: sent.length === 1 ? "Email sent" : `${sent.length} emails sent`,
          description: sent.join(", "),
        });
        onClose();
      } else {
        toast({
          title: sent.length > 0 ? `Partial send: ${sent.length} of ${sent.length + failed.length}` : "No emails sent",
          description: failed.map((f) => `${f.email}: ${f.reason}`).join(" · ").slice(0, 300),
          variant: "destructive",
        });
      }
    },
    onError: (e: any) => {
      toast({
        title: "Send failed",
        description: e?.body?.message ?? e?.message ?? "Try again.",
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Email scorecard</DialogTitle>
          <DialogDescription>
            Sends the current scorecard snapshot — team totals, per-recruiter
            performance, and pace — as an HTML email. The server renders it
            fresh at send time, so recipients see the same numbers you do.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-[hsl(var(--vs-text-muted))] mb-1">
              Recipients
            </div>
            <div
              className="min-h-[42px] w-full px-2 py-1.5 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] flex flex-wrap gap-1.5 items-center"
              onClick={(e) => {
                // Focus the input when the empty chip strip is clicked.
                const el = (e.currentTarget.querySelector("input") as HTMLInputElement | null);
                el?.focus();
              }}
            >
              {chips.map((c, i) => {
                const bad = !isEmailLike(c);
                return (
                  <span
                    key={`${c}-${i}`}
                    className={
                      "inline-flex items-center gap-1 h-6 px-2 rounded-full text-[12px] " +
                      (bad
                        ? "bg-red-500/15 text-red-600 border border-red-500/40"
                        : "bg-[#0090F0]/10 text-[#0090F0] border border-[#0090F0]/30")
                    }
                    title={bad ? "Not a valid email" : c}
                    data-testid={bad ? "chip-email-invalid" : "chip-email"}
                  >
                    {c}
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        removeChip(i);
                      }}
                      className="hover:opacity-70"
                      aria-label={`Remove ${c}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                );
              })}
              <input
                type="email"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "," || e.key === " " || e.key === "Tab") {
                    if (draft.trim()) {
                      e.preventDefault();
                      commitDraft();
                    }
                  } else if (e.key === "Backspace" && draft === "" && chips.length > 0) {
                    // Backspace on empty input peels the last chip so the
                    // user can quickly correct a typo.
                    removeChip(chips.length - 1);
                  }
                }}
                onBlur={() => {
                  if (draft.trim()) commitDraft();
                }}
                placeholder={chips.length === 0 ? "name@example.com" : ""}
                className="flex-1 min-w-[8rem] h-6 bg-transparent outline-none text-sm placeholder:text-[hsl(var(--vs-text-muted))]"
                data-testid="input-email-draft"
              />
            </div>
            {invalidChips.length > 0 && (
              <div className="mt-1 text-[11px] text-red-600">
                Fix or remove the highlighted address{invalidChips.length === 1 ? "" : "es"} before sending.
              </div>
            )}
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-wider text-[hsl(var(--vs-text-muted))] mb-1">
              Subject
            </div>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full h-9 px-2 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] text-sm"
              data-testid="input-email-subject"
            />
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-wider text-[hsl(var(--vs-text-muted))] mb-1">
              Note (optional)
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Anything you want to say above the scorecard summary."
              className="w-full px-2 py-1.5 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] text-sm resize-y"
              data-testid="input-email-note"
            />
          </div>

          <div className="text-[11px] text-[hsl(var(--vs-text-muted))]">
            Tip: for a PDF copy, use the Print button on the header — the
            browser print dialog has a “Save as PDF” option.
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-md text-sm border border-[hsl(var(--vs-border))] hover:bg-[hsl(var(--vs-surface))]"
            data-testid="button-email-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit || submit.isPending}
            onClick={() => submit.mutate()}
            className="h-9 px-4 rounded-md text-sm font-medium bg-[#0090F0] text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[#0080D8]"
            data-testid="button-email-send"
          >
            {submit.isPending ? (
              <>
                <Loader2 className="w-3.5 h-3.5 inline -mt-0.5 mr-1 animate-spin" />
                Sending…
              </>
            ) : (
              <>Send to {chips.length || 0}</>
            )}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
