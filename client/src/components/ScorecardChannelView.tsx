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

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { DollarSign, Loader2, Pencil, Plus, TrendingUp, Trophy, Users } from "lucide-react";
import type { ApiChannel } from "@/types/api";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

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
                // Pace: what fraction of the pro-rated monthly target has been
                // realized so far this month. 100% = on pace; <90% = red.
                const expectedByNow = r.monthly * monthElapsed;
                const pace = expectedByNow > 0 ? actualFee / expectedByNow : 0;
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

                    {/* Two hero numbers side-by-side: monthly and 6-month */}
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <HeroStat label="This Month" value={fmtUSD(r.monthly)} sizeClass={heroSizeClass} />
                      <HeroStat label="6-Month" value={fmtUSD(r.sixMonth)} sizeClass={heroSizeClass} />
                    </div>

                    {/* Supporting stats */}
                    <div className="mt-4 grid grid-cols-3 gap-3">
                      <MiniStat label="Floor" value={String(r.floorPlacements)} />
                      <MiniStat label="Stretch" value={fmtUSD(r.stretch)} accent />
                      <MiniStat
                        label="Actual MTD"
                        value={
                          actual
                            ? `${fmtUSD(actualFee)} · ${actual.placementsCount}`
                            : "—"
                        }
                      />
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

function LogActualsDialog({
  channelId,
  config,
  actuals,
  onClose,
}: {
  channelId: number;
  config: ScorecardConfig;
  actuals: Actual[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const currentMonth = useMemo(() => recentMonths(1)[0], []);
  const [periodMonth, setPeriodMonth] = useState(currentMonth);
  const [recruiterKey, setRecruiterKey] = useState(config.recruiters[0]?.key ?? "");
  const existing = actuals.find((a) => a.recruiterKey === recruiterKey && a.periodMonth === periodMonth);
  const [placementsCount, setPlacementsCount] = useState(String(existing?.placementsCount ?? 0));
  const [feeAmount, setFeeAmount] = useState(existing ? String(existing.feeAmountCents / 100) : "0");
  const [notes, setNotes] = useState(existing?.notes ?? "");

  const submit = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/channels/${channelId}/scorecard/actuals`, {
        recruiterKey,
        periodMonth,
        placementsCount: Math.max(0, Math.floor(Number(placementsCount))),
        feeAmountCents: Math.max(0, Math.round(Number(feeAmount) * 100)),
        notes: notes.trim() || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channelId, "scorecard"] });
      toast({ title: "Actuals saved" });
      onClose();
    },
    onError: (e: any) => {
      toast({ title: "Save failed", description: e?.body?.message ?? e?.message ?? "Try again.", variant: "destructive" });
    },
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Log placements</DialogTitle>
          <DialogDescription>Enter placements and realized fees for the month. Overwrites any prior entry for the same recruiter and month.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-[hsl(var(--vs-text-muted))] mb-1">Recruiter</div>
              <select
                className="w-full h-9 px-2 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] text-sm"
                value={recruiterKey}
                onChange={(e) => setRecruiterKey(e.target.value)}
              >
                {config.recruiters.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-[hsl(var(--vs-text-muted))] mb-1">Month</div>
              <select
                className="w-full h-9 px-2 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] text-sm tabular-nums"
                value={periodMonth}
                onChange={(e) => setPeriodMonth(e.target.value)}
              >
                {recentMonths(12).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <LabeledInput label="Placements" value={placementsCount} onChange={setPlacementsCount} />
            <LabeledInput label="Realized fees ($)" value={feeAmount} onChange={setFeeAmount} />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-[hsl(var(--vs-text-muted))] mb-1">Notes (optional)</div>
            <textarea
              className="w-full min-h-[64px] px-2 py-1.5 rounded-md bg-[hsl(var(--vs-surface))] border border-[hsl(var(--vs-border))] text-sm"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. 2 placements at Ziply, 1 at Quanta El Paso"
              maxLength={500}
            />
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
            disabled={submit.isPending}
            className="h-9 px-5 rounded-full text-[13px] font-medium bg-[#0090F0] text-white hover:bg-[#0080D8] active:scale-[0.98] transition disabled:opacity-60"
          >
            {submit.isPending ? "Saving…" : "Save"}
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
