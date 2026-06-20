/* Org-wide Jobs list view (internal data model still: work_object).
 * Renamed in UI as part of Phase 1.7.
 *
 * Launches from the sidebar "All Jobs" button. Shows every job in
 * the user's org, filterable by kind (job_site, work_project, change_order,
 * safety_incident) and status (active / closed / by-kind statuses).
 *
 * Compared to the right-rail WorkObjectPanel which is channel-scoped, this is
 * an org-wide cross-cut — useful when a foreman wants to see "all open change
 * orders" or "every safety incident this month" regardless of which channel
 * they're linked into.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  X, MapPin, Briefcase, FileEdit, AlertTriangle, ClipboardList,
  Search, Loader2, ChevronRight, Plus, Trash2,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ApiUser } from "@/types/api";
import { isManagerish } from "@/types/api";
import { CreateWorkObjectDialog } from "./CreateWorkObjectDialog";
import { WorkObjectDetailDrawer } from "./WorkObjectDetailDrawer";

type WorkObjectKind = "job_site" | "work_project" | "change_order" | "safety_incident";

interface WorkObject {
  id: number;
  kind: WorkObjectKind;
  ref: string;
  title: string;
  status: string;
  ownerUserId: number | null;
  attributes: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  me: ApiUser;
  orgMembers: ApiUser[];
  // Active company — if set, the list filters to jobs in this company. When
  // null/undefined we fall back to showing jobs across all companies the user
  // has access to (legacy behavior).
  activeProjectId?: number | null;
}

const KIND_META: Record<WorkObjectKind, { label: string; plural: string; icon: typeof MapPin; tone: string }> = {
  job_site: {
    label: "Job Site", plural: "Job Sites", icon: MapPin,
    tone: "bg-[hsl(150_50%_22%)] text-vs-green border-vs-green/30",
  },
  work_project: {
    label: "Project", plural: "Projects", icon: Briefcase,
    tone: "bg-[hsl(210_50%_22%)] text-vs-blue-light border-vs-blue-light/30",
  },
  change_order: {
    label: "Change Order", plural: "Change Orders", icon: FileEdit,
    tone: "bg-[hsl(35_60%_22%)] text-[hsl(35_100%_70%)] border-[hsl(35_100%_70%)]/30",
  },
  safety_incident: {
    label: "Safety", plural: "Safety Incidents", icon: AlertTriangle,
    tone: "bg-[hsl(174_60%_22%)] text-[hsl(174_85%_72%)] border-[hsl(174_85%_72%)]/30",
  },
};

const STATUS_TONE: Record<string, string> = {
  active: "bg-vs-green/15 text-vs-green",
  open: "bg-vs-green/15 text-vs-green",
  planned: "bg-vs-blue-light/15 text-vs-blue-light",
  paused: "bg-[hsl(35_100%_70%)]/15 text-[hsl(35_100%_70%)]",
  draft: "bg-[hsl(0_0%_40%)]/30 text-[hsl(0_0%_75%)]",
  submitted: "bg-vs-blue-light/15 text-vs-blue-light",
  approved: "bg-vs-green/15 text-vs-green",
  rejected: "bg-vs-red/15 text-vs-red",
  investigating: "bg-[hsl(35_100%_70%)]/15 text-[hsl(35_100%_70%)]",
  resolved: "bg-[hsl(0_0%_30%)]/30 text-[hsl(0_0%_60%)]",
  closed: "bg-[hsl(0_0%_30%)]/30 text-[hsl(0_0%_60%)]",
};

type KindFilter = "all" | WorkObjectKind;
type StatusFilter = "open" | "closed" | "all";

export function WorkObjectsListDialog({ open, onClose, me, orgMembers, activeProjectId }: Props) {
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  // Detail drawer state — clicking a row opens this without dismissing the list.
  const [detailId, setDetailId] = useState<number | null>(null);

  const canCreate = isManagerish(me.role);

  // Fetch all jobs in the user's org. includeClosed=1 when needed.
  // Backend already filters by org via the auth context, so we just paginate
  // generously and filter client-side for snappy UX.
  const listQ = useQuery<WorkObject[]>({
    queryKey: ["/api/work-objects", { includeClosed: statusFilter !== "open", kind: kindFilter, limit: 500, projectId: activeProjectId ?? null }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (kindFilter !== "all") params.set("kind", kindFilter);
      if (statusFilter !== "open") params.set("includeClosed", "1");
      if (activeProjectId != null) params.set("projectId", String(activeProjectId));
      params.set("limit", "500");
      return apiRequest<WorkObject[]>("GET", `/api/work-objects?${params.toString()}`);
    },
    enabled: open,
  });

  const filtered = useMemo(() => {
    const rows = listQ.data ?? [];
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter === "closed" && r.status !== "closed") return false;
      if (statusFilter === "open" && r.status === "closed") return false;
      if (q && !(r.ref.toLowerCase().includes(q) || r.title.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [listQ.data, search, statusFilter]);

  // Group by kind so the eye scans by category — matches the right-rail panel pattern.
  const grouped = useMemo(() => {
    const out = new Map<WorkObjectKind, WorkObject[]>();
    for (const row of filtered) {
      if (!out.has(row.kind)) out.set(row.kind, []);
      out.get(row.kind)!.push(row);
    }
    // Stable sort within each kind: open first, then most-recently updated.
    for (const arr of out.values()) {
      arr.sort((a, b) => {
        const aClosed = a.status === "closed" ? 1 : 0;
        const bClosed = b.status === "closed" ? 1 : 0;
        if (aClosed !== bClosed) return aClosed - bClosed;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
    }
    return out;
  }, [filtered]);

  if (!open) return null;

  const ownerLookup = new Map(orgMembers.map((m) => [m.id, m] as const));

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        data-testid="dialog-work-objects-list-backdrop"
      >
        <div
          className="w-full max-w-3xl max-h-[85vh] mx-4 flex flex-col bg-[hsl(220_55%_12%)] border border-[hsl(220_40%_25%)] rounded-lg shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
          data-testid="dialog-work-objects-list"
        >
          {/* Header */}
          <div className="px-5 py-4 border-b border-[hsl(220_40%_22%)] flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-md bg-[hsl(220_45%_22%)] flex items-center justify-center">
                <ClipboardList className="w-4 h-4 text-vs-red" />
              </div>
              <div>
                <h2 className="text-base font-display text-white">Jobs</h2>
                <p className="text-[11px] text-[hsl(0_0%_60%)]">All sites, projects, change orders & safety incidents in your org.</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {canCreate && (
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-vs-red hover:bg-vs-red/90 text-white text-xs font-semibold transition-colors"
                  data-testid="button-new-work-object"
                >
                  <Plus className="w-3.5 h-3.5" />
                  New
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="w-8 h-8 flex items-center justify-center rounded-md text-[hsl(0_0%_70%)] hover:text-white hover:bg-[hsl(220_45%_22%)]"
                data-testid="button-close-work-objects-list"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Filters */}
          <div className="px-5 py-3 border-b border-[hsl(220_40%_22%)] flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(0_0%_50%)]" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by ref or title..."
                className="w-full bg-[hsl(220_60%_9%)] border border-black/40 text-xs text-white placeholder:text-[hsl(0_0%_45%)] rounded-md pl-8 pr-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-vs-red"
                data-testid="input-work-object-search"
              />
            </div>
            <div className="flex items-center gap-1 bg-[hsl(220_60%_9%)] border border-black/40 rounded-md p-0.5" data-testid="filter-kind">
              <FilterPill label="All" active={kindFilter === "all"} onClick={() => setKindFilter("all")} testid="filter-kind-all" />
              {(Object.entries(KIND_META) as [WorkObjectKind, typeof KIND_META[WorkObjectKind]][]).map(([k, meta]) => (
                <FilterPill
                  key={k}
                  label={meta.label}
                  Icon={meta.icon}
                  active={kindFilter === k}
                  onClick={() => setKindFilter(k)}
                  testid={`filter-kind-${k}`}
                />
              ))}
            </div>
            <div className="flex items-center gap-1 bg-[hsl(220_60%_9%)] border border-black/40 rounded-md p-0.5" data-testid="filter-status">
              <FilterPill label="Open" active={statusFilter === "open"} onClick={() => setStatusFilter("open")} testid="filter-status-open" />
              <FilterPill label="Closed" active={statusFilter === "closed"} onClick={() => setStatusFilter("closed")} testid="filter-status-closed" />
              <FilterPill label="All" active={statusFilter === "all"} onClick={() => setStatusFilter("all")} testid="filter-status-all" />
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto px-5 py-3">
            {listQ.isLoading ? (
              <div className="flex items-center justify-center py-12 text-[hsl(0_0%_60%)]">
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                <span className="text-sm">Loading jobs...</span>
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-12 text-[hsl(0_0%_55%)]">
                <ClipboardList className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm font-medium text-[hsl(0_0%_75%)]">No jobs match those filters.</p>
                <p className="text-xs mt-2 max-w-sm mx-auto leading-relaxed">
                  Jobs are the real-world things your crews work on — sites, projects, change orders, safety incidents. Create one to start tracking it across channels.
                </p>
                {canCreate && (
                  <button
                    type="button"
                    onClick={() => setCreateOpen(true)}
                    className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[hsl(220_45%_22%)] hover:bg-[hsl(220_45%_28%)] text-white text-xs font-semibold transition-colors"
                    data-testid="button-empty-create-work-object"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Create the first one
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-5">
                {(Object.keys(KIND_META) as WorkObjectKind[]).map((k) => {
                  const items = grouped.get(k);
                  if (!items || items.length === 0) return null;
                  const meta = KIND_META[k];
                  const Icon = meta.icon;
                  return (
                    <section key={k} data-testid={`section-kind-${k}`}>
                      <div className="flex items-center gap-2 mb-2 px-1">
                        <Icon className="w-3.5 h-3.5 text-[hsl(0_0%_60%)]" />
                        <h3 className="text-[10px] uppercase tracking-[0.16em] font-bold text-[hsl(0_0%_65%)]">
                          {meta.plural}
                        </h3>
                        <span className="text-[10px] text-[hsl(0_0%_45%)] font-mono">{items.length}</span>
                      </div>
                      <ul className="space-y-1">
                        {items.map((wo) => (
                          <WorkObjectRow
                            key={wo.id}
                            wo={wo}
                            ownerName={wo.ownerUserId ? ownerLookup.get(wo.ownerUserId)?.name ?? null : null}
                            onOpen={() => setDetailId(wo.id)}
                            canDelete={me.role === "admin"}
                          />
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer summary */}
          <div className="px-5 py-2.5 border-t border-[hsl(220_40%_22%)] flex items-center justify-between text-[11px] text-[hsl(0_0%_55%)]">
            <span data-testid="text-work-object-count">{filtered.length} {filtered.length === 1 ? "object" : "objects"}</span>
            <span className="font-mono">org · {me.role}</span>
          </div>
        </div>
      </div>

      {/* Nested create dialog. No channelId — created objects are unlinked
          until someone links them via /object or the right-rail panel. */}
      {createOpen && (
        <CreateWorkObjectDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          me={me}
          orgMembers={orgMembers}
          projectId={activeProjectId ?? null}
          onCreated={() => {
            setCreateOpen(false);
          }}
        />
      )}
      <WorkObjectDetailDrawer
        open={detailId != null}
        workObjectId={detailId}
        onClose={() => setDetailId(null)}
        me={me}
        orgMembers={orgMembers}
      />
    </>
  );
}

function FilterPill({
  label, Icon, active, onClick, testid,
}: { label: string; Icon?: typeof MapPin; active: boolean; onClick: () => void; testid?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      className={[
        "inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold transition-colors",
        active
          ? "bg-vs-red text-white"
          : "text-[hsl(0_0%_70%)] hover:text-white hover:bg-[hsl(220_45%_22%)]",
      ].join(" ")}
    >
      {Icon && <Icon className="w-3 h-3" />}
      {label}
    </button>
  );
}

function WorkObjectRow({ wo, ownerName, onOpen, canDelete }: { wo: WorkObject; ownerName: string | null; onOpen: () => void; canDelete: boolean }) {
  const statusClass = STATUS_TONE[wo.status] ?? "bg-[hsl(0_0%_30%)]/30 text-[hsl(0_0%_70%)]";
  const updated = new Date(wo.updatedAt);
  const ago = relativeTime(updated);
  const [deleting, setDeleting] = useState(false);

  // Surface one signal-rich attribute per kind in the trailing line so the
  // user can scan without expanding. Mirrors the right-rail panel.
  const attrPreview = previewAttribute(wo);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const ok = window.confirm(
      `Delete job ${wo.ref} — “${wo.title}”?\n\nThis permanently deletes the job AND every channel nested under it, along with all messages, reactions, mentions, read receipts, member grants, recordings, and call rooms in those channels. Cannot be undone.`,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await apiRequest("DELETE", `/api/work-objects/${wo.id}`);
      // Refresh jobs lists and channel lists — a job delete may have torn
      // down channels that ChannelSidebar still has cached.
      queryClient.invalidateQueries({ queryKey: ["/api/work-objects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
    } catch (err) {
      console.error("[delete-work-object]", err);
      window.alert("Failed to delete job. Check the console for details.");
      setDeleting(false);
    }
  };

  return (
    <li className="relative group">
      <button
        type="button"
        onClick={onOpen}
        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md bg-[hsl(220_50%_15%)] border border-[hsl(220_40%_22%)] hover:border-[hsl(220_40%_32%)] hover:bg-[hsl(220_50%_17%)] transition-colors text-left"
        data-testid={`row-work-object-${wo.id}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-mono text-vs-blue-light font-semibold" data-testid={`text-ref-${wo.id}`}>
              {wo.ref}
            </span>
            <span className="text-sm text-white truncate" title={wo.title}>{wo.title}</span>
            <span className={`text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-sm ${statusClass}`}>
              {wo.status}
            </span>
          </div>
          {(attrPreview || ownerName) && (
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[hsl(0_0%_55%)] truncate">
              {ownerName && <span title="Owner">👤 {ownerName}</span>}
              {attrPreview && <span className="truncate">{attrPreview}</span>}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[10px] text-[hsl(0_0%_50%)] font-mono">{ago}</div>
        </div>
        <ChevronRight className="w-3.5 h-3.5 text-[hsl(0_0%_40%)] shrink-0" />
      </button>
      {canDelete && (
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          title="Delete job (admin)"
          data-testid={`button-delete-work-object-${wo.id}`}
          className="absolute top-1.5 right-9 opacity-0 group-hover:opacity-100 disabled:opacity-50 transition-opacity p-1 rounded text-red-300 hover:bg-red-950/40 hover:text-red-200"
        >
          {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      )}
    </li>
  );
}

function previewAttribute(wo: WorkObject): string | null {
  const a = wo.attributes ?? {};
  if (wo.kind === "job_site") {
    const customer = typeof a.customer === "string" ? a.customer : null;
    const address = typeof a.address === "string" ? a.address : null;
    return [customer, address].filter(Boolean).join(" · ") || null;
  }
  if (wo.kind === "work_project") {
    const customer = typeof a.customer === "string" ? a.customer : null;
    return customer || null;
  }
  if (wo.kind === "change_order") {
    const amount = typeof a.amount === "number" ? `$${a.amount.toLocaleString()}` : null;
    return amount || null;
  }
  if (wo.kind === "safety_incident") {
    const severity = typeof a.severity === "string" ? `severity: ${a.severity}` : null;
    const location = typeof a.location === "string" ? a.location : null;
    return [severity, location].filter(Boolean).join(" · ") || null;
  }
  return null;
}

function relativeTime(d: Date): string {
  const ms = Date.now() - d.getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
