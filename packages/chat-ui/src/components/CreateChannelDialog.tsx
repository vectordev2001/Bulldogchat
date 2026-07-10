import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { apiRequest, queryClient } from "../lib/queryClient";
import type { ApiChannel, ApiUser, ApiRegion, ChannelScope, ChannelType, UserRole } from "../types/api";
import { isManagerish } from "../types/api";
import { Loader2, Hash, Globe, Building2, Users, Lock, Briefcase, Plus, X, FileText, MapPin } from "lucide-react";

interface ApiJob {
  id: number;
  ref: string;
  title: string;
  kind: string;
  status: string;
  projectId?: number | null;
}

// Phase 1.9.3 — contracts surfaced via the chat-side proxy at
// GET /api/contracts/list. We only need a few fields here; the full
// contract record stays in bulldog-contracts.
interface ApiContract {
  id: number;
  title?: string | null;
  contractNumber?: string | null;
  documentType?: string | null;
  fileUrl?: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: number;
  me: ApiUser | null;
  onCreated?: (channel: ApiChannel) => void;
  // When opened from a job row's "New channel under …" action, preselect
  // that job so the new channel nests under it without the user re-picking.
  defaultWorkObjectId?: number | null;
}

const SCOPES: { value: ChannelScope; label: string; desc: string; Icon: typeof Globe }[] = [
  { value: "global", label: "All-Hands", desc: "Everyone in this project.", Icon: Globe },
  { value: "entity", label: "Detachment", desc: "Only users whose title matches the detachment tag.", Icon: Building2 },
  { value: "team", label: "Squad", desc: "Only users with a specific role.", Icon: Users },
  { value: "private", label: "Restricted", desc: "Only named members.", Icon: Lock },
];

const ROLES: { value: UserRole; label: string }[] = [
  { value: "user", label: "User" },
  { value: "manager", label: "Manager" },
  { value: "admin", label: "Admin" },
];

export function CreateChannelDialog({ open, onClose, projectId, me, onCreated, defaultWorkObjectId }: Props) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  // Phase 1.9: unified channels — every new channel is created with
  // type="text" and gains voice/video on demand via the in-channel call
  // button. The `type` column persists for back-compat only.
  const type: ChannelType = "text";
  const [scope, setScope] = useState<ChannelScope>("global");
  const [entityId, setEntityId] = useState("");
  const [teamRole, setTeamRole] = useState<UserRole>("user");
  const [memberIds, setMemberIds] = useState<Set<number>>(new Set());
  const [workObjectId, setWorkObjectId] = useState<string>(
    defaultWorkObjectId != null ? String(defaultWorkObjectId) : "",
  );
  // Multi-tenant Option A: optional region scope. Empty = company-wide channel.
  const [regionId, setRegionId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Phase 1.9.3 — optionally attach a contract to this new channel. When
  // set, the create POST carries a linkedContract payload and the server
  // posts a system message announcing the attach.
  const [attachContractOpen, setAttachContractOpen] = useState(false);
  const [linkedContractId, setLinkedContractId] = useState<string>("");

  // Inline "create a new job" mini-form so admins/foremen can add a job
  // without leaving this dialog. The user previously hit a blank screen
  // because the legacy setType() call crashed render — fixed by removing
  // that stale setter; this inline job creator addresses the deeper UX
  // pain ("need an easier way to add jobs and channels to companies").
  const [newJobOpen, setNewJobOpen] = useState(false);
  const [newJobTitle, setNewJobTitle] = useState("");
  const [newJobKind, setNewJobKind] = useState<"job_site" | "work_project">("job_site");
  const [newJobSaving, setNewJobSaving] = useState(false);
  const [newJobError, setNewJobError] = useState<string | null>(null);

  // Reset state whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setName("");
      setTopic("");
      // type is a const ("text") in Phase 1.9 unified channels — no setter.
      setScope("global");
      setEntityId("");
      setTeamRole("user");
      setMemberIds(new Set());
      setWorkObjectId(defaultWorkObjectId != null ? String(defaultWorkObjectId) : "");
      setRegionId("");
      setError(null);
      setLoading(false);
      setNewJobOpen(false);
      setNewJobTitle("");
      setNewJobKind("job_site");
      setNewJobSaving(false);
      setNewJobError(null);
      setAttachContractOpen(false);
      setLinkedContractId("");
    }
  }, [open, defaultWorkObjectId]);

  const orgMembersQ = useQuery<ApiUser[]>({
    queryKey: ["/api/org/members"],
    enabled: open,
  });

  // Pull contracts (via chat-side proxy) only when the user expands the
  // "Attach contract" panel — keeps the dialog snappy when they don't.
  const contractsQ = useQuery<ApiContract[]>({
    queryKey: ["/api/contracts/list"],
    enabled: open && attachContractOpen,
  });

  // Jobs in the active company — used to optionally nest the channel under a job.
  // We query through apiRequest so the query string is consistent with the rest
  // of the app and the deploy-time proxy rewrite still works.
  const jobsQ = useQuery<ApiJob[]>({
    queryKey: ["/api/work-objects", { projectId }],
    queryFn: () => apiRequest<ApiJob[]>("GET", `/api/work-objects?projectId=${projectId}`),
    enabled: open,
  });

  // Multi-tenant: regions the user can see in this company. Server filters
  // to only regions the creator has a grant for, so we render the options
  // directly.
  const regionsQ = useQuery<ApiRegion[]>({
    queryKey: ["/api/projects", projectId, "regions"],
    queryFn: () => apiRequest<ApiRegion[]>("GET", `/api/projects/${projectId}/regions`),
    enabled: open,
  });

  // Only show open jobs as nesting targets — closed/archived jobs would just clutter the picker.
  const openJobs = useMemo(() => {
    return (jobsQ.data ?? []).filter(j => j.status !== "closed" && j.status !== "archived");
  }, [jobsQ.data]);

  // Distinct entity tags inferred from user titles. Lets admins pick from
  // what already exists in the org rather than typing free-form strings.
  const knownEntities = useMemo(() => {
    const set = new Set<string>();
    for (const m of orgMembersQ.data ?? []) {
      if (m.title && m.title.trim()) set.add(m.title.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [orgMembersQ.data]);

  const toggleMember = (id: number) => {
    const next = new Set(memberIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setMemberIds(next);
  };

  // Roles allowed to create jobs (mirrors server-side requireRole). Showing
  // the inline creator to anyone else would just yield a 403, so hide it.
  const canCreateJob = isManagerish(me?.role);

  // Generate a URL-safe ref from the title — the server requires one and we
  // don't want to add another field. "BOE Fiber 2026" → "BOE-Fiber-2026".
  // Append a 4-char suffix so the (org_id, kind, ref) unique index doesn't
  // collide if the user creates two jobs with similar names.
  const slugifyRef = (title: string): string => {
    const base = title.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "job";
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `${base}-${suffix}`;
  };

  const submitNewJob = async (e: React.FormEvent) => {
    e.preventDefault();
    setNewJobError(null);
    const title = newJobTitle.trim();
    if (!title) { setNewJobError("Job name is required."); return; }
    setNewJobSaving(true);
    try {
      const created = await apiRequest<ApiJob>(
        "POST",
        `/api/work-objects?projectId=${projectId}`,
        { kind: newJobKind, ref: slugifyRef(title), title, status: "active" },
      );
      // Optimistically refresh and select the new job.
      await queryClient.invalidateQueries({ queryKey: ["/api/work-objects", { projectId }] });
      setWorkObjectId(String(created.id));
      setNewJobOpen(false);
      setNewJobTitle("");
      setNewJobKind("job_site");
    } catch (err: any) {
      setNewJobError(err?.body?.message ?? "Could not create job.");
    } finally {
      setNewJobSaving(false);
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Channel name is required."); return; }
    if (scope === "entity" && !entityId.trim()) { setError("Pick or enter an entity tag."); return; }
    if (scope === "private" && memberIds.size === 0) { setError("Add at least one member."); return; }
    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        type,
        topic: topic.trim() || null,
        scope,
      };
      if (scope === "entity") body.entityId = entityId.trim();
      if (scope === "team") body.teamRole = teamRole;
      // Any scope may carry an explicit extra-invites list. For private
      // channels these are the only members; for other scopes they layer
      // on top of the visibility rule.
      if (memberIds.size > 0) body.memberIds = Array.from(memberIds);
      if (workObjectId) body.workObjectId = Number(workObjectId);
      if (regionId) body.regionId = Number(regionId);
      // Phase 1.9.3 — nest a contract reference if the user picked one.
      // Server validates the shape and adds attachedByUserId/attachedAt.
      if (linkedContractId) {
        const picked = (contractsQ.data ?? []).find(c => String(c.id) === linkedContractId);
        if (picked) {
          // The contracts app serves PDFs at /api/contracts/:id/file and
          // the human view at /#/contracts/:id (hash-routed SPA) — mirror
          // what the server-side
          // bridge endpoint generates so behaviour is consistent across
          // entry points (contracts UI vs chat UI).
          const contractsBase = (window as any).BULLDOG_CONTRACTS_BASE
            || (import.meta as any).env?.VITE_CONTRACTS_BASE_URL
            || "https://vectorcontracts.bulldogops.com";
          body.linkedContract = {
            contractId: picked.id,
            title: picked.title || `Contract ${picked.id}`,
            ref: picked.contractNumber || null,
            appUrl: `${contractsBase}/#/contracts/${picked.id}`,
            pdfUrl: `${contractsBase}/api/contracts/${picked.id}/file`,
          };
        }
      }
      const created = await apiRequest<ApiChannel>("POST", `/api/projects/${projectId}/channels`, body);
      await queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "channels"] });
      onCreated?.(created);
      onClose();
    } catch (err: any) {
      setError(err?.body?.message ?? "Could not create channel.");
    } finally {
      setLoading(false);
    }
  };

  // Any signed-in user can create a channel. The chosen scope handles who
  // sees it.
  if (!me) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg" data-testid="dialog-create-channel">
        <DialogHeader>
          <DialogTitle>New channel</DialogTitle>
          <DialogDescription>
            Choose how visible this channel should be. You can change membership later.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          {/* Name only — every channel supports chat + voice/video. */}
          <div className="flex items-center gap-2 rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-2">
            <Hash className="h-4 w-4 text-[hsl(0_0%_70%)]" />
            <input
              value={name}
              onChange={(e) => setName(e.target.value.replace(/\s+/g, "-").toLowerCase())}
              placeholder="channel-name"
              className="w-full bg-transparent py-2 text-sm text-white outline-none placeholder:text-[hsl(0_0%_40%)]"
              data-testid="input-channel-name"
              maxLength={80}
              autoFocus
            />
          </div>
          <p className="text-[11px] text-[hsl(0_0%_55%)] -mt-2">
            Every channel supports chat plus voice/video on demand. Start a call from the channel header anytime.
          </p>

          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Topic (optional)"
            className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm text-white outline-none placeholder:text-[hsl(0_0%_40%)]"
            data-testid="input-channel-topic"
            maxLength={500}
          />

          {/* Multi-tenant: optional region scope. Empty = company-wide
              channel visible to anyone with any grant on this company.
              Picking a region restricts visibility to users with a matching
              (project, region) grant. Region list is filtered server-side
              to what the creator can see. */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs text-[hsl(0_0%_55%)]">
              <MapPin className="h-3.5 w-3.5" />
              Region (optional)
            </label>
            <select
              value={regionId}
              onChange={(e) => setRegionId(e.target.value)}
              className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm text-white"
              data-testid="select-region"
              disabled={regionsQ.isLoading}
            >
              <option value="">— Company-wide (no region)</option>
              {(regionsQ.data ?? []).map(r => (
                <option key={r.id} value={String(r.id)}>
                  {r.code} · {r.name}
                </option>
              ))}
            </select>
          </div>

          {/* Optional job nesting. Leaving this blank keeps the channel as a
              company-wide channel; picking a job nests it under that job in
              the sidebar. Admins/foremen can also spin up a new job inline
              without leaving the dialog. */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs text-[hsl(0_0%_55%)]">
                <Briefcase className="h-3.5 w-3.5" />
                Nest under job (optional)
              </label>
              {canCreateJob && !newJobOpen && (
                <button
                  type="button"
                  onClick={() => setNewJobOpen(true)}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-accent px-2 py-0.5 text-[11px] font-medium text-[hsl(0_0%_15%)] hover:bg-accent/80"
                  data-testid="button-new-job-inline"
                >
                  <Plus className="h-3 w-3" /> New job
                </button>
              )}
            </div>
            <select
              value={workObjectId}
              onChange={(e) => setWorkObjectId(e.target.value)}
              className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm text-white"
              data-testid="select-work-object"
              disabled={jobsQ.isLoading}
            >
              <option value="">— Company-wide (no job)</option>
              {openJobs.map(j => (
                <option key={j.id} value={String(j.id)}>
                  {j.ref} — {j.title} · {j.kind.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            {openJobs.length === 0 && !jobsQ.isLoading && !newJobOpen && (
              <div className="text-[11px] text-[hsl(0_0%_55%)]">
                No open jobs in this company yet{canCreateJob ? " — tap “New job” above to add one." : "."}
              </div>
            )}

            {/* Inline mini-form. Mounted as a sibling so the parent <form>'s
                onSubmit doesn't fire when the user presses Enter here — we
                bind submit on the inner <div role="group"> button instead. */}
            {newJobOpen && (
              <div className="rounded-md border border-border bg-input p-3 space-y-2" data-testid="inline-new-job">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-[hsl(0_0%_15%)]">New job in this company</div>
                  <button
                    type="button"
                    onClick={() => { setNewJobOpen(false); setNewJobError(null); }}
                    className="rounded p-0.5 text-[hsl(0_0%_55%)] hover:bg-[hsl(0_0%_15%)] hover:text-white"
                    aria-label="Cancel new job"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <input
                  value={newJobTitle}
                  onChange={(e) => setNewJobTitle(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter triggers create instead of bubbling to the outer form.
                    if (e.key === "Enter") { e.preventDefault(); void submitNewJob(e as unknown as React.FormEvent); }
                  }}
                  placeholder="Job name (e.g. BOE Fiber 2026)"
                  className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm text-white outline-none placeholder:text-[hsl(0_0%_40%)]"
                  data-testid="input-new-job-title"
                  maxLength={200}
                  autoFocus
                />
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-[hsl(0_0%_55%)]">Kind</label>
                  <select
                    value={newJobKind}
                    onChange={(e) => setNewJobKind(e.target.value as "job_site" | "work_project")}
                    className="flex-1 rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-2 py-1.5 text-xs text-white"
                    data-testid="select-new-job-kind"
                  >
                    <option value="job_site">Job site (field crew location)</option>
                    <option value="work_project">Work project (multi-site initiative)</option>
                  </select>
                </div>
                {newJobError && (
                  <div className="text-[11px] text-[hsl(0_80%_75%)]">{newJobError}</div>
                )}
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => { setNewJobOpen(false); setNewJobError(null); }}
                    className="rounded-md border border-[hsl(0_0%_18%)] px-2 py-1 text-xs hover:bg-[hsl(0_0%_12%)]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={(e) => void submitNewJob(e as unknown as React.FormEvent)}
                    disabled={newJobSaving || !newJobTitle.trim()}
                    className="inline-flex items-center gap-1 rounded-md bg-[hsl(220_70%_55%)] px-2 py-1 text-xs font-medium text-white hover:bg-[hsl(220_70%_60%)] disabled:opacity-60"
                    data-testid="button-save-new-job"
                  >
                    {newJobSaving && <Loader2 className="h-3 w-3 animate-spin" />}
                    Create job
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Phase 1.9.3 — Optional: attach a contract to this channel.
              Collapsible so the dialog stays compact for the 95% case
              where channels aren't contract-linked. */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs text-[hsl(0_0%_55%)]">
                <FileText className="h-3.5 w-3.5" />
                Attach contract (optional)
              </label>
              {!attachContractOpen && (
                <button
                  type="button"
                  onClick={() => setAttachContractOpen(true)}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-accent px-2 py-0.5 text-[11px] font-medium text-[hsl(0_0%_15%)] hover:bg-accent/80"
                  data-testid="button-attach-contract"
                >
                  <Plus className="h-3 w-3" /> Attach
                </button>
              )}
            </div>
            {attachContractOpen && (
              <div className="rounded-md border border-border bg-input p-3 space-y-2" data-testid="inline-attach-contract">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-[hsl(0_0%_15%)]">Pick a contract</div>
                  <button
                    type="button"
                    onClick={() => { setAttachContractOpen(false); setLinkedContractId(""); }}
                    className="rounded p-0.5 text-[hsl(0_0%_55%)] hover:bg-[hsl(0_0%_15%)] hover:text-white"
                    aria-label="Cancel attach contract"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <select
                  value={linkedContractId}
                  onChange={(e) => setLinkedContractId(e.target.value)}
                  className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm text-white"
                  data-testid="select-linked-contract"
                  disabled={contractsQ.isLoading}
                >
                  <option value="">— None</option>
                  {(contractsQ.data ?? []).map(c => (
                    <option key={c.id} value={String(c.id)}>
                      {c.contractNumber ? `${c.contractNumber} — ` : ""}{c.title || `Contract ${c.id}`}
                    </option>
                  ))}
                </select>
                {contractsQ.isLoading && (
                  <div className="text-[11px] text-[hsl(0_0%_55%)]">Loading contracts…</div>
                )}
                {contractsQ.error && (
                  <div className="text-[11px] text-[hsl(0_80%_75%)]">
                    Could not load contracts. {(contractsQ.error as any)?.message ?? ""}
                  </div>
                )}
                {linkedContractId && (
                  <div className="text-[11px] text-[hsl(0_0%_70%)]">
                    The contract will show as a banner at the top of the channel and as an in-call side panel.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Scope picker */}
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wider text-[hsl(0_0%_55%)]">Clearance</div>
            <div className="grid grid-cols-2 gap-2">
              {SCOPES.map(({ value, label, desc, Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setScope(value)}
                  className={`flex items-start gap-2 rounded-md border p-3 text-left transition ${
                    scope === value
                      ? "border-vs-accent bg-vs-accent-soft ring-2 ring-vs-accent"
                      : "border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] text-white hover:border-[hsl(0_0%_30%)]"
                  }`}
                  data-testid={`scope-${value}`}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(0_0%_70%)]" />
                  <div className="min-w-0">
                    <div className={`text-sm font-medium ${scope === value ? "text-[hsl(0_0%_15%)]" : "text-white"}`}>{label}</div>
                    <div className={`text-[11px] leading-tight ${scope === value ? "text-[hsl(0_0%_30%)]" : "text-[hsl(0_0%_70%)]"}`}>{desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {scope === "entity" && (
            <div className="space-y-1.5">
              <label className="text-xs text-[hsl(0_0%_55%)]">Detachment tag (matches user title)</label>
              <input
                value={entityId}
                onChange={(e) => setEntityId(e.target.value)}
                list="known-entities"
                placeholder="e.g. Bulldog Underground"
                className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm text-white outline-none placeholder:text-[hsl(0_0%_40%)]"
                data-testid="input-entity-id"
              />
              <datalist id="known-entities">
                {knownEntities.map((e) => <option key={e} value={e} />)}
              </datalist>
              <div className="text-[11px] text-[hsl(0_0%_55%)]">
                Users whose profile title equals this tag will see the channel.
              </div>
            </div>
          )}

          {scope === "team" && (
            <div className="space-y-1.5">
              <label className="text-xs text-[hsl(0_0%_55%)]">Team role</label>
              <select
                value={teamRole}
                onChange={(e) => setTeamRole(e.target.value as UserRole)}
                className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm text-white"
                data-testid="select-team-role"
              >
                {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
          )}

          {/* Optional explicit invites — works on every scope. For private
              channels these are required; for global/entity/team they are
              extra grants on top of the scope's rule. */}
          <div className="space-y-1.5">
            <label className="text-xs text-[hsl(0_0%_55%)]">
              {scope === "private"
                ? `Members (${memberIds.size} selected — you are automatically included)`
                : `Also invite specific people (optional — ${memberIds.size} selected)`}
            </label>
              <div className="max-h-48 overflow-y-auto rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] p-1 text-white">
                {(orgMembersQ.data ?? []).filter(m => m.id !== me.id).map(m => (
                  <label
                    key={m.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-[hsl(0_0%_12%)]"
                    data-testid={`member-row-${m.id}`}
                  >
                    <input
                      type="checkbox"
                      checked={memberIds.has(m.id)}
                      onChange={() => toggleMember(m.id)}
                      data-testid={`checkbox-member-${m.id}`}
                    />
                    <span className="font-medium text-white">{m.name}</span>
                    {m.title && <span className="text-[11px] text-[hsl(0_0%_55%)]">{m.title}</span>}
                    <span className="ml-auto text-[10px] uppercase tracking-wider text-[hsl(0_0%_45%)]">{m.role}</span>
                  </label>
                ))}
                {orgMembersQ.isLoading && (
                  <div className="px-2 py-3 text-xs text-[hsl(0_0%_55%)]">Loading members…</div>
                )}
              </div>
          </div>

          {error && (
            <div className="rounded-md border border-[hsl(0_70%_45%)] bg-[hsl(0_40%_15%)] px-3 py-2 text-sm text-[hsl(0_80%_85%)]" data-testid="text-error">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[hsl(0_0%_18%)] px-3 py-2 text-sm hover:bg-[hsl(0_0%_12%)]"
              data-testid="button-cancel"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-2 rounded-md bg-[hsl(220_70%_55%)] px-3 py-2 text-sm font-medium text-white hover:bg-[hsl(220_70%_60%)] disabled:opacity-60"
              data-testid="button-create"
            >
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Create channel
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
