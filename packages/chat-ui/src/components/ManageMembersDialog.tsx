/* Phase 1.8 — admin-only "Manage Members" per company.
 *
 * Shown from the Channel Sidebar header when the current user is an admin.
 * Lists every org member with a toggle showing whether they belong to the
 * active company (project). Admins can add or remove members one click at
 * a time; we never batch — flat membership means each toggle is a single
 * POST/DELETE and the server is the source of truth.
 *
 * Self-removal is blocked server-side for admins to prevent foot-guns
 * (would lose access to the company they're managing). We mirror that
 * here in the UI.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { X, Loader2, UserPlus, UserMinus, Search, Shield } from "lucide-react";
import { apiRequest, queryClient } from "../lib/queryClient";
import type { ApiProject, ApiUser } from "../types/api";

interface Props {
  open: boolean;
  onClose: () => void;
  project: ApiProject;
  me: ApiUser;
  orgMembers: ApiUser[];
}

export function ManageMembersDialog({ open, onClose, project, me, orgMembers }: Props) {
  const [search, setSearch] = useState("");
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Current company members. We refetch on every open so the toggles always
  // reflect server truth even after another admin moved someone.
  const membersQ = useQuery<ApiUser[]>({
    queryKey: ["/api/projects", project.id, "members"],
    queryFn: () => apiRequest<ApiUser[]>("GET", `/api/projects/${project.id}/members`),
    enabled: open,
  });

  const memberIdSet = useMemo(
    () => new Set((membersQ.data ?? []).map(m => m.id)),
    [membersQ.data],
  );

  const addMut = useMutation({
    mutationFn: (userId: number) =>
      apiRequest("POST", `/api/projects/${project.id}/members`, { userId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", project.id, "members"] });
      // Also bust the projects list — a member's accessible project set might
      // change which projects show up for them on next login.
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
    },
    onError: (err: Error) => setError(err.message || "Could not add member"),
    onSettled: () => setPendingId(null),
  });

  const removeMut = useMutation({
    mutationFn: (userId: number) =>
      apiRequest("DELETE", `/api/projects/${project.id}/members/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", project.id, "members"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
    },
    onError: (err: Error) => setError(err.message || "Could not remove member"),
    onSettled: () => setPendingId(null),
  });

  const toggle = (userId: number, isMember: boolean) => {
    setError(null);
    setPendingId(userId);
    if (isMember) removeMut.mutate(userId);
    else addMut.mutate(userId);
  };

  const q = search.trim().toLowerCase();
  const visible = useMemo(() => {
    const sorted = [...orgMembers].sort((a, b) => a.name.localeCompare(b.name));
    if (!q) return sorted;
    return sorted.filter(m =>
      m.name.toLowerCase().includes(q) ||
      (m.title ?? "").toLowerCase().includes(q) ||
      m.role.toLowerCase().includes(q),
    );
  }, [orgMembers, q]);

  if (!open) return null;
  const inCount = memberIdSet.size;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      data-testid="dialog-manage-members-backdrop"
    >
      <div
        className="w-full max-w-lg max-h-[85vh] mx-4 flex flex-col bg-[hsl(220_55%_12%)] border border-[hsl(220_40%_25%)] rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        data-testid="dialog-manage-members"
      >
        {/* Header — surface the company name + a count so the admin knows
            exactly what they're editing. */}
        <div className="px-5 py-4 border-b border-[hsl(220_40%_22%)] flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className="inline-flex items-center justify-center w-9 h-9 rounded-md text-[11px] font-bold text-white shrink-0"
              style={{ background: `hsl(${project.hue} 70% 38%)` }}
              aria-hidden
            >
              {project.short || project.name.slice(0, 3).toUpperCase()}
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-display text-white truncate">Manage members</h2>
              <p className="text-[11px] text-[hsl(0_0%_60%)] truncate">
                {project.name} · {inCount} of {orgMembers.length} org members in this company
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-md text-[hsl(0_0%_70%)] hover:text-white hover:bg-[hsl(220_45%_22%)]"
            aria-label="Close"
            data-testid="button-close-manage-members"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-[hsl(220_40%_22%)]">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(0_0%_50%)]" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, title, role..."
              className="w-full bg-[hsl(220_60%_9%)] border border-black/40 text-xs text-white placeholder:text-[hsl(0_0%_45%)] rounded-md pl-8 pr-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-vs-red"
              data-testid="input-member-search"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {membersQ.isLoading ? (
            <div className="flex items-center justify-center py-10 text-[hsl(0_0%_60%)]">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /><span className="text-sm">Loading...</span>
            </div>
          ) : visible.length === 0 ? (
            <div className="text-center py-10 text-[hsl(0_0%_55%)] text-sm">No org members match that search.</div>
          ) : (
            <ul className="space-y-1">
              {visible.map((m) => {
                const isMember = memberIdSet.has(m.id);
                // An admin can never remove themself from a company they're
                // currently looking at — the server blocks it, and we hide
                // the destructive affordance so they don't get an error.
                const isSelf = m.id === me.id;
                const disable = pendingId === m.id || (isSelf && isMember);
                return (
                  <li
                    key={m.id}
                    className="flex items-center gap-2 px-2 py-2 rounded-md bg-[hsl(220_50%_15%)] border border-[hsl(220_40%_22%)] hover:border-[hsl(220_40%_32%)]"
                    data-testid={`member-row-${m.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-white font-medium truncate">{m.name}</span>
                        {m.role === "admin" && (
                          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-vs-red font-mono">
                            <Shield className="w-2.5 h-2.5" /> admin
                          </span>
                        )}
                        {isSelf && (
                          <span className="text-[10px] uppercase tracking-wider text-[hsl(0_0%_55%)] font-mono">you</span>
                        )}
                      </div>
                      <div className="text-[11px] text-[hsl(0_0%_55%)] truncate">
                        {m.title || m.role}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={disable}
                      onClick={() => toggle(m.id, isMember)}
                      title={isSelf && isMember ? "Admins can't remove themselves" : isMember ? "Remove from company" : "Add to company"}
                      data-testid={`button-toggle-member-${m.id}`}
                      className={[
                        "inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-md transition-colors min-w-[78px] justify-center",
                        isMember
                          ? "bg-vs-red/15 text-vs-red border border-vs-red/30 hover:bg-vs-red/25"
                          : "bg-vs-blue-light/15 text-vs-blue-light border border-vs-blue-light/30 hover:bg-vs-blue-light/25",
                        disable ? "opacity-50 cursor-not-allowed" : "",
                      ].join(" ")}
                    >
                      {pendingId === m.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : isMember ? (
                        <><UserMinus className="w-3 h-3" /> Remove</>
                      ) : (
                        <><UserPlus className="w-3 h-3" /> Add</>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {error && (
          <div className="mx-5 mb-3 rounded-md border border-[hsl(0_70%_45%)] bg-[hsl(0_40%_15%)] px-3 py-2 text-[11px] text-[hsl(0_80%_85%)]" data-testid="text-error">
            {error}
          </div>
        )}

        <div className="px-5 py-2.5 border-t border-[hsl(220_40%_22%)] flex items-center justify-between text-[11px] text-[hsl(0_0%_55%)]">
          <span>Flat membership · admins/foremen seeded across all companies.</span>
          <span className="font-mono">{me.role}</span>
        </div>
      </div>
    </div>
  );
}
