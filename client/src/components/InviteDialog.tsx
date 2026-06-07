import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import type { ApiProject, UserRole } from "@/types/api";
import { Copy, Check, Loader2 } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  projects: ApiProject[];
  defaultProjectId: number | null;
}

const ROLES: { value: UserRole; label: string; desc: string }[] = [
  { value: "user", label: "User", desc: "Standard member — chat, calls, view." },
  { value: "manager", label: "Manager", desc: "Can create channels/jobs, pin, record." },
  { value: "admin", label: "Admin", desc: "Full org control." },
];

export function InviteDialog({ open, onClose, projects, defaultProjectId }: Props) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [projectId, setProjectId] = useState<number | null>(defaultProjectId);
  const [loading, setLoading] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await apiRequest<{ invite: any; url: string }>("POST", `/api/projects/${projectId}/invites`, {
        email: email.trim() || undefined,
        role,
      });
      setLink(r.url);
    } catch (err: any) {
      setError(err?.body?.message ?? "Could not create invite.");
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="vs-navy-panel border-[hsl(232_40%_25%)] text-white max-w-md" data-testid="dialog-invite">
        <DialogHeader>
          <DialogTitle className="font-display text-xl text-white">Invite a teammate</DialogTitle>
          <DialogDescription className="text-sm text-[hsl(0_0%_75%)]">
            Share a one-time link. New users sign in by setting their own password.
          </DialogDescription>
        </DialogHeader>

        {!link ? (
          <form onSubmit={onSubmit} className="space-y-3.5 mt-1">
            <Field label="Email (optional)">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="crewmember@vectorservicesus.com"
                className={inputCls}
                data-testid="input-invite-email"
              />
            </Field>
            <Field label="Project">
              <select
                value={projectId ?? ""}
                onChange={(e) => setProjectId(Number(e.target.value))}
                className={`${inputCls} appearance-none`}
                data-testid="select-invite-project"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id} className="bg-[hsl(232_50%_14%)]">{p.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Role">
              <div className="grid grid-cols-1 gap-1">
                {ROLES.map((r) => (
                  <button
                    type="button"
                    key={r.value}
                    onClick={() => setRole(r.value)}
                    className={[
                      "text-left px-3 py-2 rounded-md border text-[12.5px] transition-colors",
                      role === r.value
                        ? "bg-[hsl(2_70%_55%/0.12)] border-vs-red text-white"
                        : "bg-[hsl(232_50%_14%)] border-[hsl(232_40%_25%)] text-[hsl(0_0%_82%)] hover:border-vs-blue/40",
                    ].join(" ")}
                    data-testid={`button-role-${r.value}`}
                  >
                    <div className="font-semibold flex items-center justify-between">
                      <span>{r.label}</span>
                      <span className="text-[10px] font-mono uppercase tracking-wider text-vs-blue-light">{r.value}</span>
                    </div>
                    <div className="text-[11px] text-[hsl(0_0%_65%)] mt-0.5">{r.desc}</div>
                  </button>
                ))}
              </div>
            </Field>

            {error && (
              <div className="text-[12.5px] rounded-md bg-[hsl(2_70%_55%/0.12)] border border-[hsl(2_70%_55%/0.4)] text-[hsl(2_85%_72%)] px-3 py-2">{error}</div>
            )}

            <button
              type="submit"
              disabled={loading || !projectId}
              className="w-full h-10 rounded-lg bg-vs-red hover:bg-[hsl(2_75%_60%)] text-white font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
              data-testid="button-create-invite"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Generate invite link"}
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="text-sm text-[hsl(0_0%_82%)]">Share this link. It expires in 14 days.</div>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={link}
                className={inputCls + " font-mono text-[11px]"}
                onFocus={(e) => e.currentTarget.select()}
                data-testid="text-invite-link"
              />
              <button
                type="button"
                onClick={copy}
                className="h-10 px-3 rounded-md bg-vs-blue hover:bg-[hsl(218_100%_72%)] text-[hsl(232_60%_9%)] font-semibold text-xs flex items-center gap-1.5 transition-colors"
                data-testid="button-copy-invite"
              >
                {copied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
              </button>
            </div>
            <button
              type="button"
              onClick={() => { setLink(null); setEmail(""); }}
              className="text-xs text-vs-blue-light hover:underline"
              data-testid="button-new-invite"
            >
              Create another →
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const inputCls =
  "w-full h-10 px-3 rounded-md bg-[hsl(232_50%_14%)] border border-[hsl(232_40%_25%)] text-sm text-white placeholder:text-[hsl(0_0%_45%)] focus:outline-none focus:border-vs-red focus:ring-2 focus:ring-vs-red/30 transition-colors";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-[0.14em] font-bold text-[hsl(0_0%_65%)] mb-1">{label}</div>
      {children}
    </label>
  );
}
