import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ClipboardList, ChevronRight, X, Plus, Loader2, MapPin, Briefcase, FileEdit, AlertTriangle, Hash, RefreshCw } from "lucide-react";
import { apiRequest, queryClient } from "../lib/queryClient";
import type { ApiUser, ApiChannel } from "../types/api";
import { isManagerish } from "../types/api";
import { CreateWorkObjectDialog } from "./CreateWorkObjectDialog";
import { WorkObjectDetailDrawer } from "./WorkObjectDetailDrawer";

type WorkObjectKind = "job_site" | "work_project" | "change_order" | "safety_incident";

interface WorkObject {
  id: number;
  orgId: number;
  kind: WorkObjectKind;
  ref: string;
  title: string;
  status: string;
  description?: string | null;
  ownerUserId: number | null;
  parentId: number | null;
  attributes: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

interface Props {
  channelId: number;
  me: ApiUser;
  orgMembers: ApiUser[];
  onClose?: () => void;
  onSelectChannel?: (channelId: number) => void;
}

const KIND_META: Record<WorkObjectKind, { label: string; icon: typeof MapPin; tone: string }> = {
  job_site: { label: "Job Site", icon: MapPin, tone: "bg-[hsl(150_50%_22%)] text-vs-green border-vs-green/30" },
  work_project: { label: "Project", icon: Briefcase, tone: "bg-[hsl(210_50%_22%)] text-vs-blue-light border-vs-blue-light/30" },
  change_order: { label: "Change Order", icon: FileEdit, tone: "bg-[hsl(35_60%_22%)] text-[hsl(35_100%_70%)] border-[hsl(35_100%_70%)]/30" },
  safety_incident: { label: "Safety", icon: AlertTriangle, tone: "bg-[hsl(var(--vs-accent)/0.15)] text-[hsl(var(--vs-accent))] border-[hsl(var(--vs-accent)/0.3)]" },
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

function statusPill(status: string): string {
  return STATUS_TONE[status] ?? "bg-[hsl(0_0%_30%)]/30 text-[hsl(0_0%_70%)]";
}

export function WorkObjectPanel({ channelId, me, orgMembers, onClose, onSelectChannel }: Props) {
  const [linkInput, setLinkInput] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // When the user wants to swap the linked job we re-open the inline link
  // form even though a job is already attached.
  const [changing, setChanging] = useState(false);
  // Detail drawer launches over this panel; null = closed.
  const [detailId, setDetailId] = useState<number | null>(null);

  const canLink = isManagerish(me.role);

  // The data model is one-to-many: a job has many channels, but a channel has
  // at most one job. The link endpoint can technically return several rows, so
  // we treat the first as the channel's job.
  const listQ = useQuery<WorkObject[]>({
    queryKey: ["/api/channels", channelId, "work-objects"],
    queryFn: () => apiRequest<WorkObject[]>("GET", `/api/channels/${channelId}/work-objects`),
  });

  const linkedJob = useMemo(() => listQ.data?.[0] ?? null, [listQ.data]);

  // Sibling channels that share this channel's job. Only fetched once we know
  // which job is linked.
  const siblingsQ = useQuery<ApiChannel[]>({
    queryKey: ["/api/work-objects", linkedJob?.id, "channels"],
    queryFn: () => apiRequest<ApiChannel[]>("GET", `/api/work-objects/${linkedJob!.id}/channels`),
    enabled: linkedJob != null,
  });

  const siblings = useMemo(
    () => (siblingsQ.data ?? []).filter((c) => c.id !== channelId),
    [siblingsQ.data, channelId],
  );

  const linkMutation = useMutation({
    mutationFn: async (ref: string) =>
      apiRequest<WorkObject>("POST", `/api/channels/${channelId}/work-objects`, { ref }),
    onSuccess: () => {
      setLinkInput("");
      setLinkError(null);
      setChanging(false);
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channelId, "work-objects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/work-objects"] });
    },
    onError: (err: Error) => {
      setLinkError(err.message || "Could not link job");
    },
  });

  const handleLinkSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const ref = linkInput.trim();
    if (!ref) return;
    linkMutation.mutate(ref);
  };

  return (
    <aside
      className="hidden md:flex md:flex-col w-60 border-l border-[hsl(220_40%_22%)] bg-[hsl(220_60%_8%)] shrink-0"
      data-testid="panel-linked-job"
    >
      <header className="px-3 py-3 border-b border-[hsl(220_40%_22%)] flex items-center justify-between">
        <div className="flex items-center gap-2 text-[hsl(0_0%_85%)] text-sm font-semibold uppercase tracking-wide">
          <ClipboardList className="w-4 h-4" />
          Linked job
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover-elevate text-[hsl(0_0%_60%)] hover:text-white"
            title="Hide panel"
            data-testid="button-close-linked-job"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </header>

      <CreateWorkObjectDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        channelId={channelId}
        me={me}
        orgMembers={orgMembers}
      />

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
        {listQ.isLoading && (
          <div className="flex items-center justify-center py-6 text-[hsl(0_0%_60%)]" data-testid="linked-job-loading">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        )}
        {listQ.isError && (
          <div className="px-2 py-2 text-xs text-[hsl(var(--vs-accent))]" data-testid="linked-job-error">
            Failed to load job
          </div>
        )}

        {/* ── Linked job card ── */}
        {!listQ.isLoading && !listQ.isError && linkedJob && !changing && (
          <JobCard
            wo={linkedJob}
            canLink={canLink}
            onOpen={() => setDetailId(linkedJob.id)}
            onChange={() => { setChanging(true); setLinkInput(""); setLinkError(null); }}
          />
        )}

        {/* ── No job linked ── */}
        {!listQ.isLoading && !listQ.isError && !linkedJob && !changing && (
          <div className="px-1 py-2 text-xs text-[hsl(0_0%_55%)] leading-relaxed space-y-2" data-testid="linked-job-empty">
            <div className="text-[hsl(0_0%_75%)] font-medium">No job linked.</div>
            <div>
              A job is the real-world thing this channel is about — a site, a project, a change order, or a safety incident. Link one so everyone knows what work the conversation tracks.
            </div>
            {canLink && (
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="w-full flex items-center justify-center gap-1.5 rounded border border-[hsl(220_40%_22%)] bg-[hsl(220_60%_10%)] px-2 py-2 text-xs text-white hover-elevate"
                data-testid="button-empty-new-work-object"
              >
                <Plus className="w-3.5 h-3.5" /> New job
              </button>
            )}
            <div className="text-[10px] text-[hsl(0_0%_45%)] leading-tight pt-1">
              Tip: type <span className="font-mono text-[hsl(0_0%_65%)]">/job REF</span> in chat to link an existing job.
            </div>
          </div>
        )}

        {/* ── Inline link / change form ── */}
        {canLink && (changing || (!linkedJob && !listQ.isLoading && !listQ.isError)) && (
          <form onSubmit={handleLinkSubmit} className="space-y-1" data-testid="linked-job-link-form">
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={linkInput}
                onChange={(e) => { setLinkInput(e.target.value); setLinkError(null); }}
                placeholder="Link by ref (e.g. BOE-FIBER-01)"
                className="flex-1 bg-[hsl(220_60%_10%)] border border-[hsl(220_40%_22%)] rounded px-2 py-1.5 text-xs text-white placeholder:text-[hsl(0_0%_45%)] focus:outline-none focus:border-vs-red"
                data-testid="input-link-ref"
              />
              <button
                type="submit"
                disabled={!linkInput.trim() || linkMutation.isPending}
                className="p-1.5 rounded bg-vs-red/20 border border-vs-red/40 text-vs-red hover:bg-vs-red/30 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Link job"
                data-testid="button-link-work-object"
              >
                {linkMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              </button>
            </div>
            {changing && (
              <button
                type="button"
                onClick={() => { setChanging(false); setLinkInput(""); setLinkError(null); }}
                className="text-[10px] text-[hsl(0_0%_55%)] hover:text-white underline"
                data-testid="button-cancel-change-link"
              >
                Cancel
              </button>
            )}
            {linkError && <div className="text-[11px] text-[hsl(var(--vs-accent))] px-1">{linkError}</div>}
          </form>
        )}

        {/* ── Other channels in this job ── */}
        {linkedJob && !changing && (
          <div className="pt-1 border-t border-[hsl(220_40%_22%)]" data-testid="other-channels-section">
            <div className="px-1 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[hsl(0_0%_55%)]">
              Other channels in this job
            </div>
            {siblingsQ.isLoading && (
              <div className="flex items-center justify-center py-3 text-[hsl(0_0%_60%)]" data-testid="other-channels-loading">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              </div>
            )}
            {siblingsQ.isError && (
              <div className="px-1 py-2 text-[11px] text-[hsl(var(--vs-accent))]" data-testid="other-channels-error">
                Failed to load channels
              </div>
            )}
            {!siblingsQ.isLoading && !siblingsQ.isError && siblings.length === 0 && (
              <div className="px-1 py-2 text-[11px] text-[hsl(0_0%_50%)]" data-testid="other-channels-empty">
                No other channels in this job.
              </div>
            )}
            <div className="space-y-0.5">
              {siblings.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onSelectChannel?.(c.id)}
                  disabled={!onSelectChannel}
                  className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left text-[13px] text-[hsl(0_0%_80%)] hover-elevate hover:text-white disabled:cursor-default"
                  data-testid={`link-sibling-channel-${c.id}`}
                >
                  <Hash className="w-3.5 h-3.5 text-[hsl(0_0%_45%)] shrink-0" />
                  <span className="truncate">{c.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <WorkObjectDetailDrawer
        open={detailId != null}
        workObjectId={detailId}
        onClose={() => setDetailId(null)}
        me={me}
        orgMembers={orgMembers}
      />
    </aside>
  );
}

// The single job card shown when a channel has a linked job. Replaces the old
// per-row list since a channel maps to at most one job.
function JobCard({
  wo, canLink, onOpen, onChange,
}: { wo: WorkObject; canLink: boolean; onOpen: () => void; onChange: () => void }) {
  const meta = KIND_META[wo.kind];
  const Icon = meta.icon;
  return (
    <div
      className="rounded border border-[hsl(220_40%_22%)] bg-[hsl(220_60%_10%)] overflow-hidden hover:border-[hsl(220_40%_32%)] transition-colors"
      data-testid={`linked-job-card-${wo.id}`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="w-full flex items-start gap-2 px-2 py-2 text-left"
        data-testid={`button-open-work-object-${wo.id}`}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${meta.tone}`}>
              <Icon className="w-3 h-3" />
              {meta.label}
            </span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${statusPill(wo.status)}`}>
              {wo.status.replace(/_/g, " ")}
            </span>
          </div>
          <div className="text-[11px] font-mono text-[hsl(0_0%_60%)] truncate" data-testid={`text-ref-${wo.id}`}>
            {wo.ref}
          </div>
          <div className="text-[13px] text-white leading-tight truncate" data-testid={`text-title-${wo.id}`}>
            {wo.title}
          </div>
        </div>
        <ChevronRight className="w-3.5 h-3.5 text-[hsl(0_0%_40%)] shrink-0 mt-0.5" />
      </button>
      {canLink && (
        <div className="border-t border-[hsl(220_40%_22%)] px-2 py-1.5">
          <button
            type="button"
            onClick={onChange}
            className="flex items-center gap-1.5 text-[11px] text-[hsl(0_0%_60%)] hover:text-white"
            title="Link a different job to this channel"
            data-testid="button-change-link"
          >
            <RefreshCw className="w-3 h-3" /> Change link
          </button>
        </div>
      )}
    </div>
  );
}
