import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ApiChannel, ApiUser, ChannelScope, ChannelType, UserRole } from "@/types/api";
import { Loader2, Hash, Globe, Building2, Users, Lock, Briefcase } from "lucide-react";

interface ApiJob {
  id: number;
  name: string;
  kind: string;
  status: string;
  projectId?: number | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: number;
  me: ApiUser | null;
  onCreated?: (channel: ApiChannel) => void;
}

const SCOPES: { value: ChannelScope; label: string; desc: string; Icon: typeof Globe }[] = [
  { value: "global", label: "All-Hands", desc: "Everyone in this project.", Icon: Globe },
  { value: "entity", label: "Detachment", desc: "Only users whose title matches the detachment tag.", Icon: Building2 },
  { value: "team", label: "Squad", desc: "Only users with a specific role.", Icon: Users },
  { value: "private", label: "Restricted", desc: "Only named members.", Icon: Lock },
];

const ROLES: { value: UserRole; label: string }[] = [
  { value: "field", label: "Field Crew" },
  { value: "foreman", label: "Foreman" },
  { value: "office", label: "Office" },
  { value: "safety", label: "Safety" },
  { value: "admin", label: "Admin" },
];

export function CreateChannelDialog({ open, onClose, projectId, me, onCreated }: Props) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  // Phase 1.9: unified channels — every new channel is created with
  // type="text" and gains voice/video on demand via the in-channel call
  // button. The `type` column persists for back-compat only.
  const type: ChannelType = "text";
  const [scope, setScope] = useState<ChannelScope>("global");
  const [entityId, setEntityId] = useState("");
  const [teamRole, setTeamRole] = useState<UserRole>("field");
  const [memberIds, setMemberIds] = useState<Set<number>>(new Set());
  const [workObjectId, setWorkObjectId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setName("");
      setTopic("");
      setType("text");
      setScope("global");
      setEntityId("");
      setTeamRole("field");
      setMemberIds(new Set());
      setWorkObjectId("");
      setError(null);
      setLoading(false);
    }
  }, [open]);

  const orgMembersQ = useQuery<ApiUser[]>({
    queryKey: ["/api/org/members"],
    enabled: open,
  });

  // Jobs in the active company — used to optionally nest the channel under a job.
  // We query through apiRequest so the query string is consistent with the rest
  // of the app and the deploy-time proxy rewrite still works.
  const jobsQ = useQuery<ApiJob[]>({
    queryKey: ["/api/work-objects", { projectId }],
    queryFn: () => apiRequest<ApiJob[]>("GET", `/api/work-objects?projectId=${projectId}`),
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
            <Hash className="h-4 w-4 text-[hsl(0_0%_55%)]" />
            <input
              value={name}
              onChange={(e) => setName(e.target.value.replace(/\s+/g, "-").toLowerCase())}
              placeholder="channel-name"
              className="w-full bg-transparent py-2 text-sm outline-none placeholder:text-[hsl(0_0%_40%)]"
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
            className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm outline-none placeholder:text-[hsl(0_0%_40%)]"
            data-testid="input-channel-topic"
            maxLength={500}
          />

          {/* Optional job nesting. Leaving this blank keeps the channel as a
              company-wide channel; picking a job nests it under that job in
              the sidebar. */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs text-[hsl(0_0%_55%)]">
              <Briefcase className="h-3.5 w-3.5" />
              Nest under job (optional)
            </label>
            <select
              value={workObjectId}
              onChange={(e) => setWorkObjectId(e.target.value)}
              className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm"
              data-testid="select-work-object"
              disabled={jobsQ.isLoading}
            >
              <option value="">— Company-wide (no job)</option>
              {openJobs.map(j => (
                <option key={j.id} value={String(j.id)}>
                  {j.name} · {j.kind.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            {openJobs.length === 0 && !jobsQ.isLoading && (
              <div className="text-[11px] text-[hsl(0_0%_55%)]">No open jobs in this company yet.</div>
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
                      ? "border-[hsl(232_70%_60%)] bg-[hsl(232_30%_15%)]"
                      : "border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] hover:border-[hsl(0_0%_30%)]"
                  }`}
                  data-testid={`scope-${value}`}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(0_0%_70%)]" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{label}</div>
                    <div className="text-[11px] text-[hsl(0_0%_55%)] leading-tight">{desc}</div>
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
                className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm outline-none placeholder:text-[hsl(0_0%_40%)]"
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
                className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm"
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
              <div className="max-h-48 overflow-y-auto rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] p-1">
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
                    <span className="font-medium">{m.name}</span>
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
              className="flex items-center gap-2 rounded-md bg-[hsl(232_70%_55%)] px-3 py-2 text-sm font-medium text-white hover:bg-[hsl(232_70%_60%)] disabled:opacity-60"
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
