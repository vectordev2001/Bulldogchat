import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ApiUser } from "@/types/api";
import { Loader2, MapPin, Briefcase, FileEdit, AlertTriangle } from "lucide-react";

type WorkObjectKind = "job_site" | "work_project" | "change_order" | "safety_incident";

interface Props {
  open: boolean;
  onClose: () => void;
  channelId?: number;          // if provided, link to this channel after create
  // Active company. When set, the new job is created under this company so
  // it shows up in the right company’s sidebar Jobs section. The backend
  // reads this from query string or body — we send via body for consistency.
  projectId?: number | null;
  me: ApiUser;
  orgMembers: ApiUser[];
  onCreated?: () => void;
}

interface KindDef {
  value: WorkObjectKind;
  label: string;
  desc: string;
  Icon: typeof MapPin;
  refHint: string;
}

const KINDS: KindDef[] = [
  { value: "work_project",    label: "Project",       desc: "A job or contract.",                Icon: Briefcase,     refHint: "e.g. BOE-FIBER-01" },
  { value: "job_site",        label: "Job Site",      desc: "A physical location.",              Icon: MapPin,        refHint: "e.g. JS-WOODINVILLE-N5" },
  { value: "change_order",    label: "Change Order",  desc: "Scope change to a project.",        Icon: FileEdit,      refHint: "e.g. CO-BOE-FIBER-01-007" },
  { value: "safety_incident", label: "Safety",        desc: "Near-miss, injury, or incident.",   Icon: AlertTriangle, refHint: "e.g. SI-2026-014" },
];

const SAFETY_SEVERITIES = [
  { value: "near_miss",  label: "Near miss" },
  { value: "first_aid",  label: "First aid" },
  { value: "recordable", label: "Recordable" },
  { value: "lost_time",  label: "Lost time" },
  { value: "fatality",   label: "Fatality" },
];

export function CreateWorkObjectDialog({ open, onClose, channelId, projectId, me, orgMembers, onCreated }: Props) {
  const [kind, setKind] = useState<WorkObjectKind>("work_project");
  const [ref, setRef] = useState("");
  const [title, setTitle] = useState("");
  const [ownerUserId, setOwnerUserId] = useState<number | "">("");
  // Kind-specific attributes — only the most important fields are surfaced in
  // the create form. The rest can be filled in later via the detail view.
  const [customer, setCustomer] = useState("");
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [severity, setSeverity] = useState<string>("near_miss");
  const [location, setLocation] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setKind("work_project");
      setRef("");
      setTitle("");
      setOwnerUserId("");
      setCustomer("");
      setAddress("");
      setAmount("");
      setSeverity("near_miss");
      setLocation("");
      setError(null);
    }
  }, [open]);

  const createMutation = useMutation({
    mutationFn: async () => {
      // Build attributes object per kind
      const attributes: Record<string, unknown> = {};
      if (kind === "work_project" && customer.trim()) attributes.customer = customer.trim();
      if (kind === "job_site") {
        if (customer.trim()) attributes.customer = customer.trim();
        if (address.trim()) attributes.address = address.trim();
      }
      if (kind === "change_order" && amount.trim()) {
        const n = Number(amount);
        if (!Number.isFinite(n)) throw new Error("Amount must be a number");
        attributes.amount = n;
      }
      if (kind === "safety_incident") {
        if (severity) attributes.severity = severity;
        if (location.trim()) attributes.location = location.trim();
      }

      const created = await apiRequest<{ id: number; ref: string; kind: WorkObjectKind }>(
        "POST",
        "/api/work-objects",
        {
          kind,
          ref: ref.trim(),
          title: title.trim(),
          ...(ownerUserId !== "" ? { ownerUserId } : {}),
          ...(projectId != null ? { projectId } : {}),
          ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        }
      );

      // Optionally link to current channel right after create
      if (channelId) {
        try {
          await apiRequest("POST", `/api/channels/${channelId}/work-objects`, {
            workObjectId: created.id,
          });
        } catch {
          // Non-fatal — object is created, link can be retried from the panel
        }
      }
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/work-objects"] });
      if (channelId) {
        queryClient.invalidateQueries({ queryKey: ["/api/channels", channelId, "work-objects"] });
      }
      onCreated?.();
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message || "Could not create job");
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!ref.trim()) { setError("Ref is required."); return; }
    if (!/^[A-Za-z0-9._\-]+$/.test(ref.trim())) {
      setError("Ref may only contain letters, numbers, dot, dash, underscore.");
      return;
    }
    if (!title.trim()) { setError("Title is required."); return; }
    createMutation.mutate();
  };

  const canCreate = me.role === "admin" || me.role === "foreman";
  if (!canCreate) return null;

  const selectedKind = KINDS.find((k) => k.value === kind)!;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg" data-testid="dialog-create-work-object">
        <DialogHeader>
          <DialogTitle>New job</DialogTitle>
          <DialogDescription>
            {channelId
              ? "This will also be linked to the current channel."
              : "Create a project, job site, change order, or safety incident."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          {/* Kind picker */}
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wider text-[hsl(0_0%_55%)]">Type</div>
            <div className="grid grid-cols-2 gap-2">
              {KINDS.map(({ value, label, desc, Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setKind(value)}
                  className={`flex items-start gap-2 rounded-md border p-3 text-left transition ${
                    kind === value
                      ? "border-[hsl(232_70%_60%)] bg-[hsl(232_30%_15%)]"
                      : "border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] hover:border-[hsl(0_0%_30%)]"
                  }`}
                  data-testid={`kind-${value}`}
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

          {/* Ref + Title */}
          <div className="space-y-1.5">
            <label className="text-xs text-[hsl(0_0%_55%)]">Ref</label>
            <input
              value={ref}
              onChange={(e) => setRef(e.target.value.toUpperCase().replace(/[^A-Z0-9._\-]/g, ""))}
              placeholder={selectedKind.refHint}
              className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm font-mono outline-none placeholder:text-[hsl(0_0%_40%)]"
              data-testid="input-ref"
              maxLength={80}
              autoFocus
            />
            <div className="text-[11px] text-[hsl(0_0%_55%)]">
              Unique identifier. Letters, numbers, dot, dash, underscore.
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-[hsl(0_0%_55%)]">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                kind === "work_project" ? "Boeing Fiber Install — Phase 1"
                : kind === "job_site" ? "Woodinville North 5 — Pole 12"
                : kind === "change_order" ? "Added conduit run"
                : "Trench collapse — near miss"
              }
              className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm outline-none placeholder:text-[hsl(0_0%_40%)]"
              data-testid="input-title"
              maxLength={200}
            />
          </div>

          {/* Owner */}
          <div className="space-y-1.5">
            <label className="text-xs text-[hsl(0_0%_55%)]">Owner (optional)</label>
            <select
              value={ownerUserId}
              onChange={(e) => setOwnerUserId(e.target.value ? Number(e.target.value) : "")}
              className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm"
              data-testid="select-owner"
            >
              <option value="">— Unassigned —</option>
              {orgMembers.map((m) => (
                <option key={m.id} value={m.id}>{m.name}{m.title ? ` (${m.title})` : ""}</option>
              ))}
            </select>
          </div>

          {/* Kind-specific quick fields */}
          {(kind === "work_project" || kind === "job_site") && (
            <div className="space-y-1.5">
              <label className="text-xs text-[hsl(0_0%_55%)]">Customer (optional)</label>
              <input
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
                placeholder="Boeing, Comcast, City of Woodinville…"
                className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm outline-none placeholder:text-[hsl(0_0%_40%)]"
                data-testid="input-customer"
                maxLength={160}
              />
            </div>
          )}

          {kind === "job_site" && (
            <div className="space-y-1.5">
              <label className="text-xs text-[hsl(0_0%_55%)]">Address (optional)</label>
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="14010 NE 145th St, Woodinville, WA"
                className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm outline-none placeholder:text-[hsl(0_0%_40%)]"
                data-testid="input-address"
                maxLength={300}
              />
            </div>
          )}

          {kind === "change_order" && (
            <div className="space-y-1.5">
              <label className="text-xs text-[hsl(0_0%_55%)]">Amount, USD (optional)</label>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="12500"
                inputMode="decimal"
                className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm font-mono outline-none placeholder:text-[hsl(0_0%_40%)]"
                data-testid="input-amount"
              />
            </div>
          )}

          {kind === "safety_incident" && (
            <>
              <div className="space-y-1.5">
                <label className="text-xs text-[hsl(0_0%_55%)]">Severity</label>
                <select
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value)}
                  className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm"
                  data-testid="select-severity"
                >
                  {SAFETY_SEVERITIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-[hsl(0_0%_55%)]">Location (optional)</label>
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Pole 12, north side trench"
                  className="w-full rounded-md border border-[hsl(0_0%_18%)] bg-[hsl(0_0%_8%)] px-3 py-2 text-sm outline-none placeholder:text-[hsl(0_0%_40%)]"
                  data-testid="input-location"
                  maxLength={300}
                />
              </div>
            </>
          )}

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
              disabled={createMutation.isPending}
              className="flex items-center gap-2 rounded-md bg-[hsl(232_70%_55%)] px-3 py-2 text-sm font-medium text-white hover:bg-[hsl(232_70%_60%)] disabled:opacity-60"
              data-testid="button-create"
            >
              {createMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Create
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
