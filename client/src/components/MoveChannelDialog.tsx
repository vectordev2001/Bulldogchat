/* Phase 1.8 — admin-only "Move channel" action.
 *
 * Re-homes a channel to a different company and/or nests it under a
 * different Job (work_object). Backed by PATCH /api/channels/:id which
 * already validates that the target job (if any) belongs to the chosen
 * company. We never touch channel_members on move — explicit private
 * grants are preserved.
 *
 * Triggered from the sidebar's channel context menu (right-click) when
 * the current user is an admin.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { X, Loader2, ArrowRight, Hash, Volume2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ApiChannel, ApiProject } from "@/types/api";

interface SidebarJob {
  id: number;
  ref: string;
  title: string;
  status: string;
  kind: string;
  projectId: number | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  channel: ApiChannel;
  // All companies the current user can see. The active company is the source
  // so we render it preselected and let the admin pick any sibling company.
  projects: ApiProject[];
  onMoved?: (updated: ApiChannel) => void;
}

export function MoveChannelDialog({ open, onClose, channel, projects, onMoved }: Props) {
  // Source = current values. Target defaults to source so an accidental
  // submit is a no-op rather than a destructive cross-company move.
  const [targetProjectId, setTargetProjectId] = useState<number>(channel.projectId);
  const [targetWorkObjectId, setTargetWorkObjectId] = useState<number | "">(
    channel.workObjectId ?? "",
  );
  const [error, setError] = useState<string | null>(null);

  // Reset whenever the dialog reopens against a different channel.
  useEffect(() => {
    if (open) {
      setTargetProjectId(channel.projectId);
      setTargetWorkObjectId(channel.workObjectId ?? "");
      setError(null);
    }
  }, [open, channel.id, channel.projectId, channel.workObjectId]);

  // Jobs in the *target* company, not the source. When the admin swaps the
  // company dropdown, the job dropdown immediately shows the right list.
  const jobsQ = useQuery<SidebarJob[]>({
    queryKey: ["/api/work-objects", { projectId: targetProjectId }],
    queryFn: () => apiRequest<SidebarJob[]>("GET", `/api/work-objects?projectId=${targetProjectId}`),
    enabled: open,
  });

  const openJobs = useMemo(
    () => (jobsQ.data ?? []).filter(j => j.status !== "closed" && j.status !== "archived"),
    [jobsQ.data],
  );

  // If the admin changes the company, blank out the job selection because the
  // previous job belongs to the previous company. They can pick a new one.
  useEffect(() => {
    if (targetProjectId !== channel.projectId) setTargetWorkObjectId("");
  }, [targetProjectId, channel.projectId]);

  const moveMut = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      if (targetProjectId !== channel.projectId) body.projectId = targetProjectId;
      // Explicit null clears nesting; undefined leaves it alone.
      const newWoId = targetWorkObjectId === "" ? null : Number(targetWorkObjectId);
      if (newWoId !== (channel.workObjectId ?? null)) body.workObjectId = newWoId;
      if (Object.keys(body).length === 0) {
        // No-op move — close without touching the server.
        return channel;
      }
      return apiRequest<ApiChannel>("PATCH", `/api/channels/${channel.id}`, body);
    },
    onSuccess: (updated) => {
      // Refresh both source and target company channel lists so the channel
      // disappears from one sidebar and appears in the other on reopen.
      queryClient.invalidateQueries({ queryKey: ["/api/projects", channel.projectId, "channels"] });
      if (targetProjectId !== channel.projectId) {
        queryClient.invalidateQueries({ queryKey: ["/api/projects", targetProjectId, "channels"] });
      }
      onMoved?.(updated);
      onClose();
    },
    onError: (err: Error) => setError(err.message || "Could not move channel"),
  });

  if (!open) return null;

  const sourceProject = projects.find(p => p.id === channel.projectId);
  const targetProject = projects.find(p => p.id === targetProjectId);
  const isCrossCompany = targetProjectId !== channel.projectId;
  const willClearJob = targetWorkObjectId === "" && channel.workObjectId != null;
  const ChannelIcon = channel.type === "voice" ? Volume2 : Hash;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      data-testid="dialog-move-channel-backdrop"
    >
      <div
        className="w-full max-w-md mx-4 flex flex-col bg-[hsl(220_55%_12%)] border border-[hsl(220_40%_25%)] rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        data-testid="dialog-move-channel"
      >
        <div className="px-5 py-4 border-b border-[hsl(220_40%_22%)] flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-display text-white">Move channel</h2>
            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-[hsl(0_0%_60%)]">
              <ChannelIcon className="w-3 h-3" />
              <span className="font-mono truncate">{channel.name}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-md text-[hsl(0_0%_70%)] hover:text-white hover:bg-[hsl(220_45%_22%)]"
            aria-label="Close"
            data-testid="button-close-move-channel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Source summary — read-only context */}
          <div className="text-[11px] text-[hsl(0_0%_55%)]">
            <div className="uppercase tracking-wider mb-1">Currently in</div>
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-[hsl(220_60%_9%)] border border-black/40">
              {sourceProject && (
                <span
                  className="inline-flex items-center justify-center w-5 h-5 rounded text-[9px] font-bold text-white shrink-0"
                  style={{ background: `hsl(${sourceProject.hue} 70% 38%)` }}
                  aria-hidden
                >
                  {sourceProject.short || "?"}
                </span>
              )}
              <span className="text-sm text-white truncate">{sourceProject?.name ?? "Unknown company"}</span>
              {channel.workObjectId != null && (
                <span className="ml-auto text-[10px] font-mono text-vs-blue-light">job #{channel.workObjectId}</span>
              )}
            </div>
          </div>

          {/* Target company */}
          <div className="space-y-1.5">
            <label className="text-xs text-[hsl(0_0%_55%)]">Move to company</label>
            <select
              value={String(targetProjectId)}
              onChange={(e) => setTargetProjectId(Number(e.target.value))}
              className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm"
              data-testid="select-target-project"
            >
              {projects.map(p => (
                <option key={p.id} value={String(p.id)}>
                  {p.name}{p.id === channel.projectId ? " (current)" : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Target job within that company */}
          <div className="space-y-1.5">
            <label className="text-xs text-[hsl(0_0%_55%)]">Nest under job (optional)</label>
            <select
              value={targetWorkObjectId === "" ? "" : String(targetWorkObjectId)}
              onChange={(e) => setTargetWorkObjectId(e.target.value === "" ? "" : Number(e.target.value))}
              className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm"
              data-testid="select-target-work-object"
              disabled={jobsQ.isLoading}
            >
              <option value="">— Company-wide (no job)</option>
              {openJobs.map(j => (
                <option key={j.id} value={String(j.id)}>
                  {j.ref} · {j.title}
                </option>
              ))}
            </select>
            {jobsQ.isLoading && (
              <div className="text-[11px] text-[hsl(0_0%_55%)]">Loading jobs in {targetProject?.name ?? "company"}…</div>
            )}
            {!jobsQ.isLoading && openJobs.length === 0 && (
              <div className="text-[11px] text-[hsl(0_0%_55%)]">No open jobs in this company. Channel will move as company-wide.</div>
            )}
          </div>

          {/* Cross-company warning. Not blocking — just makes the consequence
              loud so the admin doesn't move #general into the wrong company. */}
          {isCrossCompany && (
            <div className="rounded-md border border-[hsl(35_60%_45%)] bg-[hsl(35_40%_15%)] px-3 py-2 text-[11px] text-[hsl(35_90%_85%)]" data-testid="warn-cross-company">
              Moving across companies: only members of <strong>{targetProject?.name}</strong> will see this channel afterwards. Private member grants are preserved.
            </div>
          )}
          {willClearJob && !isCrossCompany && (
            <div className="text-[11px] text-[hsl(0_0%_60%)]">
              Removing the job nesting — channel will become company-wide.
            </div>
          )}

          {error && (
            <div className="rounded-md border border-[hsl(0_70%_45%)] bg-[hsl(0_40%_15%)] px-3 py-2 text-[11px] text-[hsl(0_80%_85%)]" data-testid="text-error">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[hsl(220_40%_22%)] flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[hsl(0_0%_18%)] px-3 py-2 text-sm hover:bg-[hsl(0_0%_12%)]"
            data-testid="button-cancel-move"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => moveMut.mutate()}
            disabled={moveMut.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-vs-red hover:bg-vs-red/90 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
            data-testid="button-confirm-move"
          >
            {moveMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
            Move channel
          </button>
        </div>
      </div>
    </div>
  );
}
