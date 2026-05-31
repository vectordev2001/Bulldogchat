import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ClipboardList, ChevronDown, ChevronRight, X, Plus, Loader2, MapPin, Briefcase, FileEdit, AlertTriangle } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ApiUser } from "@/types/api";
import { CreateWorkObjectDialog } from "./CreateWorkObjectDialog";

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

interface WorkObjectActivity {
  id: number;
  workObjectId: number;
  actorUserId: number | null;
  type: string;
  payload: Record<string, unknown> | string | null;
  createdAt: string;
}

interface WorkObjectDetail extends WorkObject {
  activity: WorkObjectActivity[];
  channels: { channelId: number; linkType: string }[];
}

interface Props {
  channelId: number;
  me: ApiUser;
  orgMembers: ApiUser[];
  onClose?: () => void;
}

const KIND_META: Record<WorkObjectKind, { label: string; icon: typeof MapPin; tone: string }> = {
  job_site: { label: "Job Site", icon: MapPin, tone: "bg-[hsl(150_50%_22%)] text-vs-green border-vs-green/30" },
  work_project: { label: "Project", icon: Briefcase, tone: "bg-[hsl(210_50%_22%)] text-vs-blue-light border-vs-blue-light/30" },
  change_order: { label: "Change Order", icon: FileEdit, tone: "bg-[hsl(35_60%_22%)] text-[hsl(35_100%_70%)] border-[hsl(35_100%_70%)]/30" },
  safety_incident: { label: "Safety", icon: AlertTriangle, tone: "bg-[hsl(2_60%_22%)] text-[hsl(2_85%_72%)] border-[hsl(2_85%_72%)]/30" },
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

export function WorkObjectPanel({ channelId, me, orgMembers, onClose }: Props) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [linkInput, setLinkInput] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const canLink = me.role === "admin" || me.role === "foreman";

  const listQ = useQuery<WorkObject[]>({
    queryKey: ["/api/channels", channelId, "work-objects"],
    queryFn: () => apiRequest<WorkObject[]>("GET", `/api/channels/${channelId}/work-objects`),
  });

  const linkMutation = useMutation({
    mutationFn: async (ref: string) =>
      apiRequest<WorkObject>("POST", `/api/channels/${channelId}/work-objects`, { ref }),
    onSuccess: () => {
      setLinkInput("");
      setLinkError(null);
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channelId, "work-objects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/work-objects"] });
    },
    onError: (err: Error) => {
      setLinkError(err.message || "Could not link work object");
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async (workObjectId: number) =>
      apiRequest<{ ok: true }>("DELETE", `/api/channels/${channelId}/work-objects/${workObjectId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channelId, "work-objects"] });
    },
  });

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleLinkSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const ref = linkInput.trim();
    if (!ref) return;
    linkMutation.mutate(ref);
  };

  return (
    <aside
      className="hidden md:flex md:flex-col w-60 border-l border-[hsl(232_40%_22%)] bg-[hsl(232_60%_8%)] shrink-0"
      data-testid="panel-work-objects"
    >
      <header className="px-3 py-3 border-b border-[hsl(232_40%_22%)] flex items-center justify-between">
        <div className="flex items-center gap-2 text-[hsl(0_0%_85%)] text-sm font-semibold uppercase tracking-wide">
          <ClipboardList className="w-4 h-4" />
          Work Objects
        </div>
        <div className="flex items-center gap-1">
          {canLink && (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="p-1 rounded hover-elevate text-[hsl(0_0%_60%)] hover:text-white"
              title="New work object"
              data-testid="button-new-work-object"
            >
              <Plus className="w-4 h-4" />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover-elevate text-[hsl(0_0%_60%)] hover:text-white"
              title="Hide work objects"
              data-testid="button-close-work-objects"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </header>

      <CreateWorkObjectDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        channelId={channelId}
        me={me}
        orgMembers={orgMembers}
      />

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {listQ.isLoading && (
          <div className="flex items-center justify-center py-6 text-[hsl(0_0%_60%)]">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        )}
        {listQ.isError && (
          <div className="px-2 py-2 text-xs text-[hsl(2_85%_72%)]">
            Failed to load work objects
          </div>
        )}
        {!listQ.isLoading && (listQ.data?.length ?? 0) === 0 && (
          <div className="px-2 py-4 text-xs text-[hsl(0_0%_55%)] leading-relaxed space-y-2">
            <div>No work objects linked yet.</div>
            {canLink && (
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="w-full flex items-center justify-center gap-1.5 rounded border border-[hsl(232_40%_22%)] bg-[hsl(232_60%_10%)] px-2 py-2 text-xs text-white hover-elevate"
                data-testid="button-empty-new-work-object"
              >
                <Plus className="w-3.5 h-3.5" /> New work object
              </button>
            )}
          </div>
        )}

        {(listQ.data ?? []).map((wo) => {
          const meta = KIND_META[wo.kind];
          const Icon = meta.icon;
          const isOpen = expanded.has(wo.id);
          const owner = orgMembers.find((m) => m.id === wo.ownerUserId);
          return (
            <div
              key={wo.id}
              className="rounded border border-[hsl(232_40%_22%)] bg-[hsl(232_60%_10%)] overflow-hidden"
              data-testid={`card-work-object-${wo.id}`}
            >
              <button
                type="button"
                onClick={() => toggleExpand(wo.id)}
                className="w-full flex items-start gap-2 px-2 py-2 text-left hover-elevate"
              >
                <div className="mt-0.5">
                  {isOpen ? (
                    <ChevronDown className="w-3.5 h-3.5 text-[hsl(0_0%_55%)]" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-[hsl(0_0%_55%)]" />
                  )}
                </div>
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
              </button>
              {isOpen && (
                <WorkObjectDetailView
                  workObjectId={wo.id}
                  owner={owner}
                  canLink={canLink}
                  onUnlink={() => unlinkMutation.mutate(wo.id)}
                  unlinking={unlinkMutation.isPending}
                />
              )}
            </div>
          );
        })}
      </div>

      {canLink && (
        <form
          onSubmit={handleLinkSubmit}
          className="border-t border-[hsl(232_40%_22%)] p-2 space-y-1"
        >
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={linkInput}
              onChange={(e) => { setLinkInput(e.target.value); setLinkError(null); }}
              placeholder="Link by ref (e.g. BOE-FIBER-01)"
              className="flex-1 bg-[hsl(232_60%_10%)] border border-[hsl(232_40%_22%)] rounded px-2 py-1.5 text-xs text-white placeholder:text-[hsl(0_0%_45%)] focus:outline-none focus:border-vs-red"
              data-testid="input-link-ref"
            />
            <button
              type="submit"
              disabled={!linkInput.trim() || linkMutation.isPending}
              className="p-1.5 rounded bg-vs-red/20 border border-vs-red/40 text-vs-red hover:bg-vs-red/30 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Link work object"
              data-testid="button-link-work-object"
            >
              {linkMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
          {linkError && (
            <div className="text-[11px] text-[hsl(2_85%_72%)] px-1">{linkError}</div>
          )}
          <div className="text-[10px] text-[hsl(0_0%_45%)] px-1 leading-tight">
            Tip: in chat, use <span className="font-mono text-[hsl(0_0%_65%)]">/object REF</span> to link.
          </div>
        </form>
      )}
    </aside>
  );
}

function WorkObjectDetailView({
  workObjectId,
  owner,
  canLink,
  onUnlink,
  unlinking,
}: {
  workObjectId: number;
  owner?: ApiUser;
  canLink: boolean;
  onUnlink: () => void;
  unlinking: boolean;
}) {
  const detailQ = useQuery<WorkObjectDetail>({
    queryKey: ["/api/work-objects", workObjectId],
    queryFn: () => apiRequest<WorkObjectDetail>("GET", `/api/work-objects/${workObjectId}`),
  });

  if (detailQ.isLoading) {
    return (
      <div className="px-3 py-2 border-t border-[hsl(232_40%_22%)] flex items-center gap-2 text-[11px] text-[hsl(0_0%_55%)]">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading
      </div>
    );
  }

  if (!detailQ.data) return null;

  const wo = detailQ.data;
  const attrs = wo.attributes ?? {};
  const attrEntries = Object.entries(attrs).filter(([, v]) => v != null && v !== "");

  return (
    <div className="border-t border-[hsl(232_40%_22%)] px-3 py-2 space-y-2 bg-[hsl(232_60%_7%)]">
      {owner && (
        <div className="text-[11px] text-[hsl(0_0%_70%)]">
          <span className="text-[hsl(0_0%_50%)]">Owner: </span>
          {owner.name}
        </div>
      )}
      {attrEntries.length > 0 && (
        <div className="space-y-0.5">
          {attrEntries.map(([k, v]) => (
            <div key={k} className="text-[11px] leading-tight">
              <span className="text-[hsl(0_0%_50%)]">{k}: </span>
              <span className="text-[hsl(0_0%_85%)]">
                {typeof v === "object" ? JSON.stringify(v) : String(v)}
              </span>
            </div>
          ))}
        </div>
      )}
      {wo.activity.length > 0 && (
        <div className="pt-1 border-t border-[hsl(232_40%_18%)]">
          <div className="text-[10px] uppercase tracking-wide text-[hsl(0_0%_50%)] mb-1">Recent activity</div>
          <div className="space-y-0.5 max-h-24 overflow-y-auto">
            {wo.activity.slice(0, 5).map((a) => (
              <div key={a.id} className="text-[10px] text-[hsl(0_0%_65%)] leading-tight">
                <span className="font-mono">{a.type}</span>
                <span className="text-[hsl(0_0%_40%)]"> · {new Date(a.createdAt).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {canLink && (
        <button
          type="button"
          onClick={onUnlink}
          disabled={unlinking}
          className="w-full text-[10px] text-[hsl(0_0%_55%)] hover:text-[hsl(2_85%_72%)] py-1 disabled:opacity-40"
          data-testid={`button-unlink-${wo.id}`}
        >
          {unlinking ? "Unlinking…" : "Unlink from channel"}
        </button>
      )}
    </div>
  );
}
