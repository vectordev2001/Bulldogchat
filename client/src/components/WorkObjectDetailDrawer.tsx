/* Work-object detail drawer.
 *
 * Opens from row clicks in WorkObjectsListDialog (org-wide list) and
 * WorkObjectPanel (right-rail per-channel). Single full-height side
 * drawer over the page. Shows:
 *   - Header: ref, title, kind, status pill
 *   - Inline edit (title, status, owner, description, per-kind attributes)
 *   - Status actions (Close / Reopen) for admins + foremen
 *   - Linked channels list
 *   - Activity log (newest first)
 *
 * All mutations go through PATCH /api/work-objects/:id or the close/reopen
 * endpoints, which fire the Phase 1.5 system-message banners into linked
 * channels automatically.
 */
import { useEffect, useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  X, MapPin, Briefcase, FileEdit, AlertTriangle, ClipboardList,
  Loader2, Lock, Unlock, Save, History, Hash, User, Edit3, Volume2,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ApiUser } from "@/types/api";
import { isManagerish } from "@/types/api";

type WorkObjectKind = "job_site" | "work_project" | "change_order" | "safety_incident";

// Statuses appropriate to each kind. Server allows the full union but UX
// works better when we only show the relevant subset per kind.
const STATUSES_BY_KIND: Record<WorkObjectKind, string[]> = {
  job_site:        ["planned", "active", "paused", "closed"],
  work_project:    ["planned", "active", "paused", "closed"],
  change_order:    ["draft", "submitted", "approved", "rejected", "closed"],
  safety_incident: ["open", "investigating", "resolved", "closed"],
};

interface WorkObjectDetail {
  id: number;
  kind: WorkObjectKind;
  ref: string;
  title: string;
  status: string;
  description: string | null;
  ownerUserId: number | null;
  attributes: Record<string, unknown>;
  createdByUserId: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  activity: Array<{
    id: number;
    type: string;
    actorUserId: number | null;
    payload: string | null;
    createdAt: string;
  }>;
  channels: Array<{ id: number; name: string; type: string }>;
}

interface Props {
  open: boolean;
  workObjectId: number | null;
  onClose: () => void;
  me: ApiUser;
  orgMembers: ApiUser[];
}

const KIND_META: Record<WorkObjectKind, { label: string; icon: typeof MapPin; tone: string }> = {
  job_site:        { label: "Job Site",     icon: MapPin,         tone: "text-vs-green" },
  work_project:    { label: "Project",      icon: Briefcase,      tone: "text-vs-blue-light" },
  change_order:    { label: "Change Order", icon: FileEdit,       tone: "text-[hsl(35_100%_70%)]" },
  safety_incident: { label: "Safety",       icon: AlertTriangle,  tone: "text-[hsl(174_85%_72%)]" },
};

const STATUS_TONE: Record<string, string> = {
  active:        "bg-vs-green/20 text-vs-green border-vs-green/40",
  open:          "bg-vs-green/20 text-vs-green border-vs-green/40",
  planned:       "bg-vs-blue-light/20 text-vs-blue-light border-vs-blue-light/40",
  paused:        "bg-[hsl(35_100%_70%)]/20 text-[hsl(35_100%_70%)] border-[hsl(35_100%_70%)]/40",
  draft:         "bg-[hsl(0_0%_40%)]/30 text-[hsl(0_0%_75%)] border-[hsl(0_0%_40%)]/40",
  submitted:     "bg-vs-blue-light/20 text-vs-blue-light border-vs-blue-light/40",
  approved:      "bg-vs-green/20 text-vs-green border-vs-green/40",
  rejected:      "bg-vs-red/20 text-vs-red border-vs-red/40",
  investigating: "bg-[hsl(35_100%_70%)]/20 text-[hsl(35_100%_70%)] border-[hsl(35_100%_70%)]/40",
  resolved:      "bg-[hsl(0_0%_30%)]/30 text-[hsl(0_0%_60%)] border-[hsl(0_0%_30%)]/40",
  closed:        "bg-[hsl(0_0%_30%)]/30 text-[hsl(0_0%_60%)] border-[hsl(0_0%_30%)]/40",
};

export function WorkObjectDetailDrawer({ open, workObjectId, onClose, me, orgMembers }: Props) {
  const { toast } = useToast();
  const [editMode, setEditMode] = useState(false);

  const canEdit = isManagerish(me.role);

  const detailQ = useQuery<WorkObjectDetail>({
    queryKey: ["/api/work-objects", workObjectId],
    queryFn: () => apiRequest<WorkObjectDetail>("GET", `/api/work-objects/${workObjectId}`),
    enabled: open && workObjectId != null,
  });

  // Local edit buffer — populated when entering edit mode. Storing a single
  // object so we can pass the full patch to PATCH at save time.
  const [edits, setEdits] = useState<{
    title?: string;
    status?: string;
    ownerUserId?: number | null;
    description?: string | null;
    attributes?: Record<string, unknown>;
  }>({});

  // Reset edit state whenever the drawer closes or we switch objects.
  useEffect(() => {
    if (!open) {
      setEditMode(false);
      setEdits({});
    }
  }, [open, workObjectId]);

  const patchMut = useMutation({
    mutationFn: async (patch: typeof edits) =>
      apiRequest("PATCH", `/api/work-objects/${workObjectId}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/work-objects", workObjectId] });
      queryClient.invalidateQueries({ queryKey: ["/api/work-objects"] });
      setEditMode(false);
      setEdits({});
      toast({ title: "Saved", description: "Job updated." });
    },
    onError: (err: unknown) => {
      toast({
        title: "Update failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const closeMut = useMutation({
    mutationFn: () => apiRequest("POST", `/api/work-objects/${workObjectId}/close`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/work-objects", workObjectId] });
      queryClient.invalidateQueries({ queryKey: ["/api/work-objects"] });
      toast({ title: "Closed", description: "Job closed." });
    },
  });

  const reopenMut = useMutation({
    mutationFn: () => apiRequest("POST", `/api/work-objects/${workObjectId}/reopen`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/work-objects", workObjectId] });
      queryClient.invalidateQueries({ queryKey: ["/api/work-objects"] });
      toast({ title: "Reopened", description: "Job reopened." });
    },
  });

  const wo = detailQ.data;

  // When entering edit mode, seed the buffer from current values.
  function startEdit() {
    if (!wo) return;
    setEdits({
      title: wo.title,
      status: wo.status,
      ownerUserId: wo.ownerUserId,
      description: wo.description,
      attributes: { ...wo.attributes },
    });
    setEditMode(true);
  }

  function saveEdit() {
    if (!wo) return;
    // Only send fields that actually changed — keeps activity log clean
    // and avoids triggering a system message for a no-op.
    const patch: typeof edits = {};
    if (edits.title !== undefined && edits.title !== wo.title) patch.title = edits.title;
    if (edits.status !== undefined && edits.status !== wo.status) patch.status = edits.status;
    if (edits.ownerUserId !== undefined && edits.ownerUserId !== wo.ownerUserId) patch.ownerUserId = edits.ownerUserId;
    if (edits.description !== undefined && (edits.description ?? null) !== (wo.description ?? null)) patch.description = edits.description;
    if (edits.attributes && JSON.stringify(edits.attributes) !== JSON.stringify(wo.attributes)) {
      patch.attributes = edits.attributes;
    }
    if (Object.keys(patch).length === 0) {
      setEditMode(false);
      return;
    }
    patchMut.mutate(patch);
  }

  const memberLookup = useMemo(
    () => new Map(orgMembers.map((m) => [m.id, m] as const)),
    [orgMembers],
  );

  if (!open || workObjectId == null) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      data-testid="drawer-work-object-detail-backdrop"
    >
      <aside
        className="w-full max-w-xl h-full bg-[hsl(220_55%_12%)] border-l border-[hsl(220_40%_25%)] shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-testid="drawer-work-object-detail"
      >
        {detailQ.isLoading || !wo ? (
          <div className="flex-1 flex items-center justify-center text-[hsl(0_0%_60%)]">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            <span className="text-sm">Loading...</span>
          </div>
        ) : (
          <>
            <Header wo={wo} onClose={onClose} />
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              <CoreFields
                wo={wo}
                edits={edits}
                setEdits={setEdits}
                editMode={editMode}
                memberLookup={memberLookup}
                orgMembers={orgMembers}
              />
              <AttributesSection
                wo={wo}
                edits={edits}
                setEdits={setEdits}
                editMode={editMode}
              />
              <DescriptionSection
                wo={wo}
                edits={edits}
                setEdits={setEdits}
                editMode={editMode}
              />
              <LinkedChannelsSection channels={wo.channels} />
              <ActivitySection activity={wo.activity} memberLookup={memberLookup} />
            </div>
            <Footer
              wo={wo}
              canEdit={canEdit}
              editMode={editMode}
              onStartEdit={startEdit}
              onCancelEdit={() => { setEditMode(false); setEdits({}); }}
              onSaveEdit={saveEdit}
              onClose={() => closeMut.mutate()}
              onReopen={() => reopenMut.mutate()}
              saving={patchMut.isPending}
              closing={closeMut.isPending || reopenMut.isPending}
            />
          </>
        )}
      </aside>
    </div>
  );
}

/* ─── Header ─── */
function Header({ wo, onClose }: { wo: WorkObjectDetail; onClose: () => void }) {
  const meta = KIND_META[wo.kind];
  const Icon = meta.icon;
  const statusClass = STATUS_TONE[wo.status] ?? "bg-[hsl(0_0%_30%)]/30 text-[hsl(0_0%_70%)] border-[hsl(0_0%_30%)]/40";

  return (
    <div className="px-5 py-4 border-b border-[hsl(220_40%_22%)] flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11px] text-[hsl(0_0%_60%)] mb-1">
          <Icon className={`w-3.5 h-3.5 ${meta.tone}`} />
          <span className="uppercase tracking-wider font-semibold">{meta.label}</span>
          <span className="text-[hsl(0_0%_40%)]">·</span>
          <span className="font-mono text-vs-blue-light" data-testid="text-detail-ref">{wo.ref}</span>
        </div>
        <h2 className="text-lg font-display text-white truncate" data-testid="text-detail-title" title={wo.title}>
          {wo.title}
        </h2>
        <div className="mt-2">
          <span className={`inline-block text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-sm border ${statusClass}`}>
            {wo.status}
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="w-8 h-8 flex items-center justify-center rounded-md text-[hsl(0_0%_70%)] hover:text-white hover:bg-[hsl(220_45%_22%)] shrink-0"
        data-testid="button-close-detail-drawer"
        aria-label="Close"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/* ─── Core fields (title, status, owner) ─── */
function CoreFields({
  wo, edits, setEdits, editMode, memberLookup, orgMembers,
}: {
  wo: WorkObjectDetail;
  edits: any;
  setEdits: (e: any) => void;
  editMode: boolean;
  memberLookup: Map<number, ApiUser>;
  orgMembers: ApiUser[];
}) {
  const allowedStatuses = STATUSES_BY_KIND[wo.kind];
  const ownerName = wo.ownerUserId ? memberLookup.get(wo.ownerUserId)?.name ?? `user #${wo.ownerUserId}` : "Unassigned";

  return (
    <section>
      <SectionTitle icon={Hash}>Details</SectionTitle>
      <dl className="grid grid-cols-3 gap-x-3 gap-y-3 text-sm">
        <Field label="Title">
          {editMode ? (
            <input
              type="text"
              value={edits.title ?? ""}
              onChange={(e) => setEdits({ ...edits, title: e.target.value })}
              className="w-full bg-[hsl(220_60%_9%)] border border-black/40 text-sm text-white rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-vs-red"
              data-testid="input-edit-title"
            />
          ) : (
            <span className="text-white" data-testid="text-detail-title-value">{wo.title}</span>
          )}
        </Field>
        <Field label="Status">
          {editMode ? (
            <select
              value={edits.status ?? wo.status}
              onChange={(e) => setEdits({ ...edits, status: e.target.value })}
              className="w-full bg-[hsl(220_60%_9%)] border border-black/40 text-sm text-white rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-vs-red"
              data-testid="select-edit-status"
            >
              {allowedStatuses.map((s) => (<option key={s} value={s}>{s}</option>))}
            </select>
          ) : (
            <span className="text-white capitalize" data-testid="text-detail-status-value">{wo.status}</span>
          )}
        </Field>
        <Field label="Owner">
          {editMode ? (
            <select
              value={edits.ownerUserId ?? ""}
              onChange={(e) => setEdits({ ...edits, ownerUserId: e.target.value ? Number(e.target.value) : null })}
              className="w-full bg-[hsl(220_60%_9%)] border border-black/40 text-sm text-white rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-vs-red"
              data-testid="select-edit-owner"
            >
              <option value="">Unassigned</option>
              {orgMembers.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          ) : (
            <span className="text-white flex items-center gap-1" data-testid="text-detail-owner-value">
              <User className="w-3.5 h-3.5 text-[hsl(0_0%_50%)]" />
              {ownerName}
            </span>
          )}
        </Field>
      </dl>
    </section>
  );
}

/* ─── Per-kind attributes ─── */
function AttributesSection({
  wo, edits, setEdits, editMode,
}: { wo: WorkObjectDetail; edits: any; setEdits: (e: any) => void; editMode: boolean }) {
  const current = (editMode ? edits.attributes : wo.attributes) ?? {};

  // Per-kind editable fields. Keep it tight — matches CreateWorkObjectDialog.
  const fields: Array<{ key: string; label: string; type: "text" | "number" | "select"; options?: string[] }> =
    wo.kind === "job_site"        ? [
      { key: "customer", label: "Customer", type: "text" },
      { key: "address",  label: "Address",  type: "text" },
    ] :
    wo.kind === "work_project"    ? [
      { key: "customer", label: "Customer", type: "text" },
    ] :
    wo.kind === "change_order"    ? [
      { key: "amount",   label: "Amount ($)", type: "number" },
    ] :
    /* safety_incident */           [
      { key: "severity", label: "Severity",  type: "select", options: ["low", "moderate", "high", "critical"] },
      { key: "location", label: "Location",  type: "text" },
    ];

  function setAttr(key: string, value: unknown) {
    setEdits({ ...edits, attributes: { ...(edits.attributes ?? {}), [key]: value } });
  }

  return (
    <section>
      <SectionTitle icon={FileEdit}>Attributes</SectionTitle>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        {fields.map((f) => {
          const raw = current[f.key];
          const displayValue = raw === null || raw === undefined || raw === "" ? "—" : String(raw);
          return (
            <Field key={f.key} label={f.label}>
              {editMode ? (
                f.type === "select" && f.options ? (
                  <select
                    value={raw == null ? "" : String(raw)}
                    onChange={(e) => setAttr(f.key, e.target.value || null)}
                    className="w-full bg-[hsl(220_60%_9%)] border border-black/40 text-sm text-white rounded-md px-2 py-1.5"
                    data-testid={`select-attr-${f.key}`}
                  >
                    <option value="">—</option>
                    {f.options.map((o) => (<option key={o} value={o}>{o}</option>))}
                  </select>
                ) : (
                  <input
                    type={f.type === "number" ? "number" : "text"}
                    value={raw == null ? "" : String(raw)}
                    onChange={(e) => {
                      const v = f.type === "number"
                        ? (e.target.value === "" ? null : Number(e.target.value))
                        : (e.target.value === "" ? null : e.target.value);
                      setAttr(f.key, v);
                    }}
                    className="w-full bg-[hsl(220_60%_9%)] border border-black/40 text-sm text-white rounded-md px-2 py-1.5"
                    data-testid={`input-attr-${f.key}`}
                  />
                )
              ) : (
                <span className="text-white" data-testid={`text-attr-${f.key}`}>
                  {f.type === "number" && raw != null ? `$${Number(raw).toLocaleString()}` : displayValue}
                </span>
              )}
            </Field>
          );
        })}
      </dl>
    </section>
  );
}

/* ─── Description ─── */
function DescriptionSection({
  wo, edits, setEdits, editMode,
}: { wo: WorkObjectDetail; edits: any; setEdits: (e: any) => void; editMode: boolean }) {
  const value = editMode ? (edits.description ?? "") : (wo.description ?? "");

  return (
    <section>
      <SectionTitle icon={Edit3}>Description</SectionTitle>
      {editMode ? (
        <textarea
          value={value}
          onChange={(e) => setEdits({ ...edits, description: e.target.value || null })}
          rows={4}
          placeholder="Add notes, scope, or context..."
          className="w-full bg-[hsl(220_60%_9%)] border border-black/40 text-sm text-white rounded-md px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-vs-red placeholder:text-[hsl(0_0%_40%)] resize-y"
          data-testid="textarea-edit-description"
        />
      ) : value ? (
        <p className="text-sm text-[hsl(0_0%_85%)] whitespace-pre-wrap" data-testid="text-detail-description">
          {value}
        </p>
      ) : (
        <p className="text-sm text-[hsl(0_0%_45%)] italic">No description.</p>
      )}
    </section>
  );
}

/* ─── Linked channels ─── */
function LinkedChannelsSection({ channels }: { channels: WorkObjectDetail["channels"] }) {
  return (
    <section>
      <SectionTitle icon={Hash}>Linked Channels</SectionTitle>
      {channels.length === 0 ? (
        <p className="text-sm text-[hsl(0_0%_45%)] italic">Not linked to any channels.</p>
      ) : (
        <ul className="space-y-1" data-testid="list-linked-channels">
          {channels.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-[hsl(220_50%_15%)] border border-[hsl(220_40%_22%)] text-sm"
            >
              {c.type === "voice" ? (
                <Volume2 className="w-3.5 h-3.5 text-[hsl(0_0%_55%)]" />
              ) : (
                <Hash className="w-3.5 h-3.5 text-[hsl(0_0%_55%)]" />
              )}
              <span className="text-white">{c.name}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ─── Activity log ─── */
function ActivitySection({
  activity, memberLookup,
}: { activity: WorkObjectDetail["activity"]; memberLookup: Map<number, ApiUser> }) {
  return (
    <section>
      <SectionTitle icon={History}>Activity</SectionTitle>
      {activity.length === 0 ? (
        <p className="text-sm text-[hsl(0_0%_45%)] italic">No activity yet.</p>
      ) : (
        <ol className="space-y-2" data-testid="list-activity">
          {activity.map((ev) => {
            const actor = ev.actorUserId ? memberLookup.get(ev.actorUserId)?.name ?? `user #${ev.actorUserId}` : "system";
            const summary = summarizeActivity(ev);
            return (
              <li
                key={ev.id}
                className="text-[12px] text-[hsl(0_0%_70%)] border-l-2 border-[hsl(220_40%_22%)] pl-3 py-0.5"
                data-testid={`activity-${ev.id}`}
              >
                <span className="text-white font-medium">{actor}</span>
                <span className="text-[hsl(0_0%_55%)]"> {summary}</span>
                <span className="ml-2 text-[10px] text-[hsl(0_0%_45%)] font-mono">{fmtTime(ev.createdAt)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function summarizeActivity(ev: WorkObjectDetail["activity"][number]): string {
  let payload: any = null;
  if (ev.payload) {
    try { payload = JSON.parse(ev.payload); } catch { /* ignore */ }
  }
  switch (ev.type) {
    case "created":
      return `created this ${payload?.kind ?? "object"}`;
    case "linked":
      return `linked to #${payload?.channelName ?? payload?.channelId ?? "?"}`;
    case "unlinked":
      return `unlinked from #${payload?.channelName ?? payload?.channelId ?? "?"}`;
    case "status_changed":
      return `changed status: ${payload?.from ?? "?"} → ${payload?.to ?? "?"}`;
    case "owner_changed":
      return `changed owner`;
    case "closed":
      return `closed this object`;
    case "reopened":
      return `reopened this object`;
    case "updated":
      return payload?.field ? `updated ${payload.field}` : `updated this object`;
    default:
      return ev.type.replace(/_/g, " ");
  }
}

/* ─── Footer (actions) ─── */
function Footer({
  wo, canEdit, editMode, onStartEdit, onCancelEdit, onSaveEdit, onClose, onReopen, saving, closing,
}: {
  wo: WorkObjectDetail; canEdit: boolean; editMode: boolean;
  onStartEdit: () => void; onCancelEdit: () => void; onSaveEdit: () => void;
  onClose: () => void; onReopen: () => void;
  saving: boolean; closing: boolean;
}) {
  if (!canEdit) {
    return (
      <div className="px-5 py-3 border-t border-[hsl(220_40%_22%)] text-[11px] text-[hsl(0_0%_50%)]">
        Read-only · only admins and foremen can edit jobs.
      </div>
    );
  }
  const isClosed = wo.status === "closed";

  if (editMode) {
    return (
      <div className="px-5 py-3 border-t border-[hsl(220_40%_22%)] flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancelEdit}
          disabled={saving}
          className="px-3 py-1.5 rounded-md text-sm text-[hsl(0_0%_75%)] hover:text-white hover:bg-[hsl(220_45%_22%)] disabled:opacity-50"
          data-testid="button-cancel-edit"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSaveEdit}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-vs-red hover:bg-vs-red/90 text-white text-sm font-semibold disabled:opacity-50"
          data-testid="button-save-edit"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Save changes
        </button>
      </div>
    );
  }

  return (
    <div className="px-5 py-3 border-t border-[hsl(220_40%_22%)] flex items-center justify-between gap-2">
      {isClosed ? (
        <button
          type="button"
          onClick={onReopen}
          disabled={closing}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[hsl(220_45%_22%)] hover:bg-[hsl(220_45%_28%)] text-white text-sm font-semibold disabled:opacity-50"
          data-testid="button-reopen-work-object"
        >
          <Unlock className="w-3.5 h-3.5" />
          Reopen
        </button>
      ) : (
        <button
          type="button"
          onClick={onClose}
          disabled={closing}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[hsl(220_45%_22%)] hover:bg-[hsl(220_45%_28%)] text-white text-sm font-semibold disabled:opacity-50"
          data-testid="button-close-work-object"
        >
          <Lock className="w-3.5 h-3.5" />
          Close
        </button>
      )}
      <button
        type="button"
        onClick={onStartEdit}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-vs-red hover:bg-vs-red/90 text-white text-sm font-semibold"
        data-testid="button-edit-work-object"
      >
        <Edit3 className="w-3.5 h-3.5" />
        Edit
      </button>
    </div>
  );
}

/* ─── Small layout helpers ─── */
function SectionTitle({ icon: Icon, children }: { icon: typeof MapPin; children: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] font-bold text-[hsl(0_0%_65%)] mb-2">
      <Icon className="w-3 h-3" />
      {children}
    </h3>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-[hsl(0_0%_50%)] mb-1">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
