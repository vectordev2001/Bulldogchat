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
 *   6-month revenue target = 6-month salary / (1 - profitTarget)
 *   monthly target         = 6-month revenue target / 6
 *   floor placements       = round(6-month revenue target / averageFee)
 *   stretch                = base * stretchMultiplier
 *   pace                   = actuals sum this period / expected pace to date
 *
 * Salaries are never rendered in this view — only derived $ targets. The
 * server strips salaries from the non-admin projection as a defense in
 * depth; this view also does not show salaries in the admin projection to
 * keep the peer-visible surface clean (admins see them in the edit dialog).
 */

import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { BarChart3, DollarSign, Loader2, Pencil, Plus, Trash2, TrendingUp, Trophy, Users, X } from "lucide-react";
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
}
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

/** Compute per-recruiter targets from the config. Pure — no side effects. */
function computeTargets(cfg: ScorecardConfig) {
  const totalMonthlySalary = cfg.recruiters.reduce((s, r) => s + (r.monthlySalary ?? 0), 0);
  const totalSixMonthSalary = totalMonthlySalary * 6;
  // Team-level revenue target = 6mo salary / (1 - profit%). Same shape per
  // recruiter (only meaningful in the admin view where salaries are known).
  const denom = Math.max(0.01, 1 - cfg.profitTarget);
  const teamSixMonthRevenue = totalSixMonthSalary / denom;
  const teamMonthlyRevenue = teamSixMonthRevenue / 6;
  const teamFloorPlacements = Math.round(teamSixMonthRevenue / Math.max(1, cfg.averageFee));

  const perRecruiter = cfg.recruiters.map((r) => {
    const salary6mo = (r.monthlySalary ?? 0) * 6;
    const sixMonthRevenue = salary6mo / denom;
    const monthly = sixMonthRevenue / 6;
    const floorPlacements = Math.round(sixMonthRevenue / Math.max(1, cfg.averageFee));
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
      hasSalary: r.monthlySalary != null,
    };
  });

  return { totalSixMonthSalary, teamSixMonthRevenue, teamMonthlyRevenue, teamFloorPlacements, perRecruiter };
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

/* ─────────────────── main view ─────────────────── */

export function ScorecardChannelView({ channel }: Props) {
  const q = useQuery<ScorecardResponse>({
    queryKey: ["/api/channels", channel.id, "scorecard"],
    queryFn: () => apiRequest<ScorecardResponse>("GET", `/api/channels/${channel.id}/scorecard`),
    staleTime: 15_000,
  });

  const [editOpen, setEditOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

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

  // Roll up current-month actuals per recruiter for the pace pill.
  const currentMonthByRecruiter = new Map<string, Actual>();
  for (const a of actuals) {
    if (a.periodMonth === currentMonth) currentMonthByRecruiter.set(a.recruiterKey, a);
  }

  // Trailing 6-month actuals per recruiter (fee $ + placements) so each card
  // can show "where they actually are" against the 6-month goal. Uses the
  // same recentMonths() window the leaderboard's rolling-3mo view is based on.
  const trailing6Months = recentMonths(6);
  const trailing6MonthsSet = new Set(trailing6Months);
  // Popover range — oldest→newest of the trailing 6-month window.
  const sixMoRange = {
    from: trailing6Months[trailing6Months.length - 1] ?? currentMonth,
    to: trailing6Months[0] ?? currentMonth,
  };
  const trailing6ByRecruiter = new Map<string, { fee: number; placements: number }>();
  for (const a of actuals) {
    if (!trailing6MonthsSet.has(a.periodMonth)) continue;
    const entry = trailing6ByRecruiter.get(a.recruiterKey) ?? { fee: 0, placements: 0 };
    entry.fee += (a.feeAmountCents ?? 0) / 100;
    entry.placements += a.placementsCount ?? 0;
    trailing6ByRecruiter.set(a.recruiterKey, entry);
  }

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
    <div className="flex-1 min-h-0 flex flex-col bg-[hsl(var(--vs-surface))]">
      {/* Header — matches TextChannelView's 14-row header size + hairline */}
      <div className="h-14 border-b border-[hsl(var(--vs-border))] px-4 md:px-6 flex items-center gap-3 shrink-0">
        <div className="w-8 h-8 rounded-full flex items-center justify-center bg-gradient-to-br from-[#0090F0] to-[#0064B8] shadow-sm">
          <DollarSign className="w-4 h-4 text-white" strokeWidth={2.5} />
        </div>
        <div className="min-w-0">
          <div className="font-display text-[hsl(var(--vs-text))] text-base truncate">{channel.name}</div>
          {channel.topic && (
            <div className="text-[11px] text-[hsl(var(--vs-text-muted))] truncate">{channel.topic}</div>
          )}
        </div>
        {canEdit && (
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setLogOpen(true)}
              className="h-8 px-3 rounded-full text-[13px] font-medium bg-[#0090F0] text-white hover:bg-[#0080D8] active:scale-[0.98] transition shadow-[0_1px_2px_rgba(0,144,240,0.35)]"
              data-testid="button-log-actuals"
            >
              <Plus className="w-3.5 h-3.5 inline -ml-0.5 mr-1 -mt-0.5" />
              Log placements
            </button>
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              className="h-8 w-8 rounded-full flex items-center justify-center text-[hsl(var(--vs-text-muted))] hover:text-[#0090F0] hover-elevate transition"
              title="Edit scorecard config"
              data-testid="button-edit-config"
            >
              <Pencil className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-8 py-6 md:py-8">
        <div className="max-w-5xl mx-auto space-y-6">
          {/* Team summary card */}
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="rounded-2xl bg-gradient-to-br from-[#0090F0] to-[#0064B8] text-white p-6 md:p-7 shadow-[0_10px_30px_-12px_rgba(0,100,184,0.55)]"
          >
            <div className="flex items-center gap-2 text-white/80 text-[12px] uppercase tracking-wider font-medium">
              <TrendingUp className="w-3.5 h-3.5" />
              6-month team target
            </div>
            <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
              <SummaryStat
                label="Team revenue target"
                value={fmtUSD(targets.teamSixMonthRevenue)}
                sub="6 months"
              />
              <SummaryStat
                label="Monthly team target"
                value={fmtUSD(targets.teamMonthlyRevenue)}
                sub="per month"
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

          {/* Team performance chart — per-recruiter progress bars toward
              their MONTHLY goal, tinted by pace. Rendered above the
              per-recruiter cards so the team picture reads first. */}
          <TeamPerformanceChart
            perRecruiter={targets.perRecruiter}
            currentMonthByRecruiter={currentMonthByRecruiter}
            monthElapsed={monthElapsed}
            thresholds={config.thresholds}
          />

          {/* Per-recruiter cards */}
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
                // Pace: what fraction of the pro-rated monthly target has been
                // realized so far this month. 100% = on pace; <90% = red.
                const expectedByNow = r.monthly * monthElapsed;
                const pace = expectedByNow > 0 ? actualFee / expectedByNow : 0;
                // 6-month attainment vs goal — used for the secondary hero's
                // subtle color and the reference row's % note.
                const sixMonthAttainment = r.sixMonth > 0 ? trailing6.fee / r.sixMonth : 0;
                return (
                  <motion.div
                    key={r.key}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, delay: 0.03 * i }}
                    className={`rounded-2xl bg-white dark:bg-[hsl(var(--vs-surface-elevated))] border border-[hsl(var(--vs-border))] ${cardPadClass} shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover-elevate transition`}
                    data-testid={`recruiter-card-${r.key}`}
                  >
                    {/* Header: name + pace pill */}
                    <div className="flex items-start justify-between gap-3">
                      <div className={`font-display ${nameSizeClass} text-[hsl(var(--vs-text))] truncate`}>{r.name}</div>
                      <PacePill pace={pace} thresholds={config.thresholds} hasActuals={actual != null} />
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
                        scope={{ kind: "range", fromMonth: sixMoRange.from, toMonth: sixMoRange.to, label: "Last 6 months" }}
                        canEdit={canEdit}
                      >
                        <button
                          type="button"
                          className="text-left w-full rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0090F0]/60"
                          data-testid={`hero-6mo-${r.key}`}
                        >
                          <ActualHeroStat
                            label="Actual 6-mo"
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
                        actuals above first. */}
                    <div className="mt-4 pt-3 border-t border-dashed border-[hsl(var(--vs-border))] grid grid-cols-3 gap-3">
                      <MiniStat label="Monthly goal" value={fmtUSD(r.monthly)} />
                      <MiniStat label="6-mo goal" value={fmtUSD(r.sixMonth)} />
                      <MiniStat label="Stretch" value={fmtUSD(r.stretch)} />
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
 * The bigger, brighter hero used for actuals (MTD + trailing 6mo). Wrapped in
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
 * Team performance chart — one horizontal progress bar per recruiter
 * showing where they are toward their MONTHLY goal. Fill percent is
 * (actual MTD / monthly goal); tint is by pace (actual / expected-by-now)
 * so "green" reads consistently with the pace pill on each recruiter card.
 *
 * A subtle vertical marker at the pro-rated "expected pace" position
 * lets you read at a glance whether the bar is ahead of or behind pace
 * without needing to do the math in your head.
 */
function TeamPerformanceChart({
  perRecruiter,
  currentMonthByRecruiter,
  monthElapsed,
  thresholds,
}: {
  perRecruiter: Array<{ key: string; name: string; monthly: number }>;
  currentMonthByRecruiter: Map<string, Actual>;
  monthElapsed: number;
  thresholds: { green: number; yellow: number };
}) {
  const rows = perRecruiter.map((r) => {
    const actual = currentMonthByRecruiter.get(r.key);
    const actualFee = (actual?.feeAmountCents ?? 0) / 100;
    // Progress toward monthly goal, 0..1+ (bar can exceed goal).
    const progress = r.monthly > 0 ? actualFee / r.monthly : 0;
    // Pace vs expected — uses the same thresholds as PacePill.
    const expectedByNow = r.monthly * monthElapsed;
    const pace = expectedByNow > 0 ? actualFee / expectedByNow : 0;
    return {
      key: r.key,
      name: r.name,
      actualFee,
      monthly: r.monthly,
      placements: actual?.placementsCount ?? 0,
      progress,
      pace,
      hasActuals: actual != null,
    };
  });

  // If nobody has any goals AND no actuals, there's nothing to draw.
  const hasAnyData = rows.some((r) => r.monthly > 0 || r.actualFee > 0);
  if (!hasAnyData) return null;

  const colorFor = (pace: number, hasActuals: boolean) => {
    if (!hasActuals) return "#94a3b8"; // slate-400 — no actuals yet
    if (pace >= thresholds.green) return "#10b981"; // emerald-500
    if (pace >= thresholds.yellow) return "#f59e0b"; // amber-500
    if (pace > 0) return "#ef4444"; // red-500
    return "#94a3b8";
  };

  // Cap the visible fill at 130% so a runaway month doesn't blow past the
  // container. We still show the raw percent in the label.
  const clampFill = (p: number) => Math.min(1.3, Math.max(0, p));
  const pacePct = Math.round(monthElapsed * 100);

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="rounded-2xl bg-white dark:bg-[hsl(var(--vs-surface-elevated))] border border-[hsl(var(--vs-border))] p-4 md:p-5 mb-4"
      data-testid="team-performance-chart"
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider font-medium text-[hsl(var(--vs-text-muted))]">
          <BarChart3 className="w-3.5 h-3.5 text-[#0090F0]" />
          Team pace — progress toward monthly goal
        </div>
        <div className="hidden md:flex items-center gap-3 text-[11px] text-[hsl(var(--vs-text-muted))]">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#10b981]" /> On pace
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#f59e0b]" /> Behind
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#ef4444]" /> Off track
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-0.5 h-3 bg-[hsl(var(--vs-text-muted))]" /> Today ({pacePct}%)
          </span>
        </div>
      </div>
      <div className="space-y-2">
        {rows.map((row, i) => {
          const fillPct = clampFill(row.progress) * 100;
          const color = colorFor(row.pace, row.hasActuals);
          // Pro-rated pace marker: sits at monthElapsed% of the 100% mark.
          // Because the bar container represents 0–130%, the marker's
          // absolute left is (monthElapsed * 100) / 130.
          const paceMarkerLeftPct = (monthElapsed * 100) / 1.3;
          const goalMarkerLeftPct = 100 / 1.3;
          return (
            <motion.div
              key={row.key}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2, delay: 0.03 * i }}
              className="grid grid-cols-[minmax(80px,120px)_1fr_120px] items-center gap-3"
              data-testid={`chart-row-${row.key}`}
            >
              <div className="text-[12px] font-medium text-[hsl(var(--vs-text))] truncate">{row.name}</div>
              <div className="relative h-6 rounded-full bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] overflow-hidden">
                {/* Fill — tinted by pace */}
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${fillPct}%` }}
                  transition={{ duration: 0.5, ease: "easeOut", delay: 0.05 * i }}
                  className="absolute inset-y-0 left-0"
                  style={{ background: color, opacity: row.hasActuals ? 0.85 : 0.35 }}
                />
                {/* Pace marker (today, pro-rated) */}
                <div
                  className="absolute inset-y-0 border-l border-dashed border-[hsl(var(--vs-text-muted))]/60"
                  style={{ left: `${paceMarkerLeftPct}%` }}
                  aria-hidden
                />
                {/* 100% goal marker */}
                <div
                  className="absolute inset-y-0 border-l-2 border-[hsl(var(--vs-text))]/40"
                  style={{ left: `${goalMarkerLeftPct}%` }}
                  aria-hidden
                />
                {/* Inline percent label — sits inside the bar when there's
                    room, otherwise nudges to the right of the fill. */}
                <div
                  className="absolute inset-y-0 flex items-center text-[11px] font-semibold tabular-nums"
                  style={{
                    left: fillPct > 12 ? `${Math.min(fillPct - 2, 96)}%` : `${fillPct + 1}%`,
                    transform: fillPct > 12 ? "translateX(-100%)" : "none",
                    color: fillPct > 12 ? "white" : "hsl(var(--vs-text-muted))",
                    textShadow: fillPct > 12 ? "0 1px 2px rgba(0,0,0,0.25)" : "none",
                    paddingLeft: fillPct > 12 ? 0 : 4,
                    paddingRight: fillPct > 12 ? 6 : 0,
                  }}
                >
                  {row.hasActuals ? `${Math.round(row.progress * 100)}%` : "—"}
                </div>
              </div>
              <div className="text-[11px] text-[hsl(var(--vs-text-muted))] tabular-nums text-right truncate">
                {row.hasActuals ? fmtUSD(row.actualFee) : "No data"}
                {row.monthly > 0 && (
                  <span className="text-[hsl(var(--vs-text-muted))]/70"> / {fmtUSD(row.monthly)}</span>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>
    </motion.div>
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
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

function MiniStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
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
