import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ArrowLeft, Users as UsersIcon, FolderKanban, Mail, Settings as SettingsIcon, Loader2, Trash2, KeyRound, LogOut, Copy, Check, Plus } from "lucide-react";
import { useLocation } from "wouter";
import { Avatar } from "@/components/Avatar";
import { VectorLogo } from "@/components/VectorLogo";
import { useAuth } from "@/lib/auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ApiUser, ApiProject, UserRole } from "@/types/api";

type Tab = "users" | "projects" | "invites" | "settings";

const ROLE_LABEL: Record<UserRole, string> = {
  admin: "Admin", manager: "Manager", user: "User",
};

export default function AdminPanel() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<Tab>("users");

  if (!user) {
    setLocation("/login");
    return null;
  }
  if (user.role !== "admin") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[hsl(232_60%_9%)] text-white gap-4 p-6 text-center">
        <VectorLogo size={48} className="text-vs-red" monochrome />
        <h1 className="text-xl font-display">Admin access required</h1>
        <p className="text-sm text-white/60 max-w-md">You don't have permission to view the admin panel.</p>
        <button onClick={() => setLocation("/")} className="px-4 py-2 bg-vs-red rounded-md hover:bg-[hsl(2_75%_60%)] text-sm font-semibold">Back to chat</button>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[hsl(232_60%_9%)] text-white">
      <header className="h-14 px-4 flex items-center gap-3 border-b border-[hsl(232_40%_22%)] bg-[hsl(232_60%_12%)] shrink-0">
        <button
          type="button"
          onClick={() => setLocation("/")}
          className="p-2 rounded hover:bg-[hsl(232_45%_22%)] text-[hsl(0_0%_75%)] hover:text-white"
          title="Back to chat"
          data-testid="button-back-to-chat"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <VectorLogo size={22} className="text-vs-red" monochrome />
        <div className="font-display text-base">Admin Panel</div>
        <span className="ml-auto text-xs text-[hsl(0_0%_55%)] font-mono">{user.name} · Admin</span>
      </header>

      <div className="flex-1 flex min-h-0">
        <nav className="w-56 shrink-0 border-r border-[hsl(232_40%_22%)] bg-[hsl(232_55%_11%)] py-3 px-2 space-y-1" data-testid="nav-admin-tabs">
          <NavBtn icon={<UsersIcon className="w-4 h-4" />} label="Users" active={tab === "users"} onClick={() => setTab("users")} />
          <NavBtn icon={<FolderKanban className="w-4 h-4" />} label="Projects" active={tab === "projects"} onClick={() => setTab("projects")} />
          <NavBtn icon={<Mail className="w-4 h-4" />} label="Invites" active={tab === "invites"} onClick={() => setTab("invites")} />
          <NavBtn icon={<SettingsIcon className="w-4 h-4" />} label="Settings" active={tab === "settings"} onClick={() => setTab("settings")} />
        </nav>
        <main className="flex-1 min-w-0 overflow-y-auto p-6">
          {tab === "users" && <UsersTab />}
          {tab === "projects" && <ProjectsTab />}
          {tab === "invites" && <InvitesTab />}
          {tab === "settings" && <SettingsTab />}
        </main>
      </div>
    </div>
  );
}

function NavBtn({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "w-full text-left flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors",
        active ? "bg-vs-red/15 text-vs-red border border-vs-red/30" : "text-[hsl(0_0%_75%)] hover:bg-[hsl(232_45%_22%)] hover:text-white border border-transparent",
      ].join(" ")}
      data-testid={`tab-${label.toLowerCase()}`}
    >
      {icon}
      {label}
    </button>
  );
}

// ─────────── USERS TAB ───────────
function UsersTab() {
  const usersQ = useQuery<ApiUser[]>({ queryKey: ["/api/admin/users"] });
  const [tempPw, setTempPw] = useState<{ id: number; pw: string } | null>(null);

  const patchUser = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: any }) =>
      apiRequest("PATCH", `/api/admin/users/${id}`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] }),
  });

  const resetPw = useMutation({
    mutationFn: async (id: number) => apiRequest<{ tempPassword: string }>("POST", `/api/admin/users/${id}/reset-password`),
    onSuccess: (res, id) => setTempPw({ id, pw: res.tempPassword }),
  });

  const forceLogout = useMutation({
    mutationFn: async (id: number) => apiRequest("POST", `/api/admin/users/${id}/force-logout`),
  });

  const delUser = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/users/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] }),
  });

  if (usersQ.isLoading) return <Loading />;
  const users = usersQ.data ?? [];

  return (
    <div>
      <h1 className="text-xl font-display mb-4">Team Members <span className="text-sm text-[hsl(0_0%_55%)] font-sans">· {users.length}</span></h1>
      <div className="rounded-lg border border-[hsl(232_40%_22%)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[hsl(232_55%_14%)] text-[10px] uppercase tracking-wider text-[hsl(0_0%_60%)]">
            <tr>
              <th className="text-left px-4 py-2">Member</th>
              <th className="text-left px-4 py-2">Role</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-right px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-[hsl(232_40%_22%)] hover:bg-[hsl(232_45%_15%)]" data-testid={`user-row-${u.id}`}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar member={{ name: u.name, hue: u.hue }} size={32} />
                    <div className="min-w-0">
                      <div className="text-white font-semibold truncate">{u.name}</div>
                      <div className="text-[11px] text-[hsl(0_0%_60%)] font-mono truncate">{u.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <select
                    className="bg-[hsl(232_55%_14%)] border border-[hsl(232_40%_22%)] text-xs rounded px-2 py-1 text-white"
                    value={u.role}
                    onChange={(e) => patchUser.mutate({ id: u.id, patch: { role: e.target.value } })}
                    data-testid={`select-role-${u.id}`}
                  >
                    {Object.entries(ROLE_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-[10px] uppercase font-mono tracking-wider px-2 py-0.5 rounded border ${u.status === "online" ? "bg-vs-green/15 text-vs-green border-vs-green/30" : "bg-[hsl(232_45%_22%)] text-[hsl(0_0%_70%)] border-[hsl(232_40%_30%)]"}`}>
                    {u.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-1">
                    <IconBtn title="Reset password" onClick={() => resetPw.mutate(u.id)} testid={`btn-reset-${u.id}`}>
                      <KeyRound className="w-3.5 h-3.5" />
                    </IconBtn>
                    <IconBtn title="Force logout" onClick={() => forceLogout.mutate(u.id)} testid={`btn-logout-${u.id}`}>
                      <LogOut className="w-3.5 h-3.5" />
                    </IconBtn>
                    <IconBtn title="Delete user" onClick={() => {
                      if (confirm(`Delete ${u.name}? Their messages will remain but they can't log in.`)) delUser.mutate(u.id);
                    }} testid={`btn-delete-${u.id}`} variant="danger">
                      <Trash2 className="w-3.5 h-3.5" />
                    </IconBtn>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {tempPw && (
        <div className="mt-4 p-4 rounded-lg bg-[hsl(35_100%_60%/0.1)] border border-[hsl(35_100%_60%/0.4)]">
          <div className="text-xs uppercase font-mono tracking-wider text-[hsl(35_100%_72%)] mb-1">Temporary password issued for user #{tempPw.id}</div>
          <div className="flex items-center gap-2">
            <code className="px-3 py-1.5 bg-black/40 rounded font-mono text-vs-amber text-base flex-1">{tempPw.pw}</code>
            <button type="button" onClick={() => { navigator.clipboard.writeText(tempPw.pw); }} className="px-3 py-1.5 bg-[hsl(232_45%_22%)] hover:bg-[hsl(232_45%_28%)] rounded text-sm">Copy</button>
            <button type="button" onClick={() => setTempPw(null)} className="px-3 py-1.5 text-[hsl(0_0%_60%)] hover:text-white text-sm">Dismiss</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────── PROJECTS TAB ───────────
function ProjectsTab() {
  const projectsQ = useQuery<(ApiProject & { memberCount: number; channelCount: number })[]>({
    queryKey: ["/api/admin/projects"],
  });
  const delProj = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/projects/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/projects"] }),
  });

  if (projectsQ.isLoading) return <Loading />;
  const projects = projectsQ.data ?? [];

  return (
    <div>
      <h1 className="text-xl font-display mb-4">Projects <span className="text-sm text-[hsl(0_0%_55%)] font-sans">· {projects.length}</span></h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {projects.map((p) => (
          <div key={p.id} className="p-4 rounded-lg bg-[hsl(232_50%_14%)] border border-[hsl(232_40%_22%)]" data-testid={`project-card-${p.id}`}>
            <div className="flex items-center gap-3 mb-3">
              <div
                className="w-11 h-11 rounded-lg font-display flex items-center justify-center text-white text-sm"
                style={{ background: `linear-gradient(135deg, hsl(${p.hue} 60% 40%), hsl(${(p.hue + 30) % 360} 60% 25%))` }}
              >
                {p.short}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-display text-white text-sm truncate">{p.name}</div>
                <div className="text-[11px] font-mono text-[hsl(0_0%_60%)] truncate">{p.slug}</div>
              </div>
            </div>
            {p.description && <p className="text-xs text-[hsl(0_0%_70%)] mb-3 line-clamp-2">{p.description}</p>}
            <div className="flex items-center justify-between text-[11px] font-mono text-[hsl(0_0%_60%)]">
              <span>{p.memberCount} members</span>
              <span>{p.channelCount} channels</span>
            </div>
            <button
              type="button"
              onClick={() => { if (confirm(`Delete project "${p.name}" and all its channels/messages? This cannot be undone.`)) delProj.mutate(p.id); }}
              className="mt-3 w-full text-xs text-vs-red hover:bg-vs-red/15 px-2 py-1.5 rounded border border-vs-red/30 transition-colors"
              data-testid={`btn-delete-project-${p.id}`}
            >
              <Trash2 className="w-3 h-3 inline mr-1" /> Delete project
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────── INVITES TAB ───────────
function InvitesTab() {
  const invitesQ = useQuery<any[]>({ queryKey: ["/api/admin/invites"] });
  const [role, setRole] = useState<UserRole>("user");
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const createInvite = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/admin/invites`, { role, expiresInDays: 14 }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/invites"] }),
  });
  const delInvite = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/invites/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/invites"] }),
  });

  if (invitesQ.isLoading) return <Loading />;
  const invites = invitesQ.data ?? [];

  return (
    <div>
      <h1 className="text-xl font-display mb-4">Invites</h1>
      <div className="mb-4 p-4 rounded-lg bg-[hsl(232_50%_14%)] border border-[hsl(232_40%_22%)] flex items-center gap-3">
        <span className="text-sm text-[hsl(0_0%_75%)]">Generate invite for role:</span>
        <select
          className="bg-[hsl(232_55%_18%)] border border-[hsl(232_40%_22%)] text-sm rounded px-2 py-1.5 text-white"
          value={role}
          onChange={(e) => setRole(e.target.value as UserRole)}
          data-testid="select-invite-role"
        >
          {Object.entries(ROLE_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <button
          type="button"
          onClick={() => createInvite.mutate()}
          disabled={createInvite.isPending}
          className="px-3 py-1.5 bg-vs-red text-white rounded text-sm font-semibold flex items-center gap-1.5 hover:bg-[hsl(2_75%_60%)] disabled:opacity-50"
          data-testid="button-create-invite"
        >
          <Plus className="w-3.5 h-3.5" /> Create
        </button>
      </div>

      <div className="rounded-lg border border-[hsl(232_40%_22%)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[hsl(232_55%_14%)] text-[10px] uppercase tracking-wider text-[hsl(0_0%_60%)]">
            <tr>
              <th className="text-left px-4 py-2">URL</th>
              <th className="text-left px-4 py-2">Role</th>
              <th className="text-left px-4 py-2">Expires</th>
              <th className="text-right px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {invites.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-[hsl(0_0%_55%)] text-sm">No invites yet</td></tr>
            )}
            {invites.map((i) => (
              <tr key={i.id} className="border-t border-[hsl(232_40%_22%)] hover:bg-[hsl(232_45%_15%)]" data-testid={`invite-row-${i.id}`}>
                <td className="px-4 py-3 max-w-md">
                  <code className="text-xs font-mono text-vs-blue-light truncate block">{i.url}</code>
                </td>
                <td className="px-4 py-3 text-white">{ROLE_LABEL[i.role as UserRole]}</td>
                <td className="px-4 py-3 text-[hsl(0_0%_70%)] font-mono text-xs">{new Date(i.expiresAt).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-1">
                    <IconBtn title="Copy URL" onClick={() => { navigator.clipboard.writeText(i.url); setCopiedId(i.id); setTimeout(() => setCopiedId(null), 1500); }} testid={`btn-copy-${i.id}`}>
                      {copiedId === i.id ? <Check className="w-3.5 h-3.5 text-vs-green" /> : <Copy className="w-3.5 h-3.5" />}
                    </IconBtn>
                    <IconBtn title="Revoke" variant="danger" onClick={() => delInvite.mutate(i.id)} testid={`btn-revoke-${i.id}`}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </IconBtn>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────── SETTINGS TAB ───────────
function SettingsTab() {
  const orgQ = useQuery<any>({ queryKey: ["/api/admin/org"] });
  const [name, setName] = useState("");
  const [plan, setPlan] = useState("");
  const [saved, setSaved] = useState(false);
  const patch = useMutation({
    mutationFn: async () => apiRequest("PATCH", `/api/admin/org`, { name, plan }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/org"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    },
  });

  if (orgQ.isLoading) return <Loading />;
  const org = orgQ.data;
  if (org && !name && !plan) {
    setName(org.name);
    setPlan(org.plan);
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-xl font-display mb-4">Organization Settings</h1>
      <div className="p-5 rounded-lg bg-[hsl(232_50%_14%)] border border-[hsl(232_40%_22%)] space-y-4">
        <Field label="Organization name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-[hsl(232_55%_18%)] border border-[hsl(232_40%_22%)] rounded px-3 py-2 text-white text-sm focus:border-vs-red outline-none"
            data-testid="input-org-name"
          />
        </Field>
        <Field label="Plan">
          <select
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
            className="w-full bg-[hsl(232_55%_18%)] border border-[hsl(232_40%_22%)] rounded px-3 py-2 text-white text-sm"
            data-testid="select-org-plan"
          >
            <option value="starter">Starter</option>
            <option value="growth">Growth</option>
            <option value="enterprise">Enterprise</option>
          </select>
        </Field>
        <Field label="Slug">
          <input type="text" value={org?.slug ?? ""} disabled className="w-full bg-[hsl(232_55%_14%)] border border-[hsl(232_40%_22%)] rounded px-3 py-2 text-[hsl(0_0%_60%)] text-sm font-mono" />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          {saved && <span className="text-vs-green text-xs flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Saved</span>}
          <button type="button" onClick={() => patch.mutate()} disabled={patch.isPending} className="px-4 py-2 bg-vs-red text-white rounded text-sm font-semibold disabled:opacity-50 hover:bg-[hsl(2_75%_60%)]" data-testid="button-save-org">
            {patch.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider font-mono text-[hsl(0_0%_60%)] block mb-1">{label}</label>
      {children}
    </div>
  );
}

function IconBtn({ children, onClick, title, testid, variant }: { children: React.ReactNode; onClick: () => void; title: string; testid?: string; variant?: "danger" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-testid={testid}
      className={[
        "w-7 h-7 rounded flex items-center justify-center transition-colors",
        variant === "danger" ? "text-[hsl(2_85%_72%)] hover:bg-vs-red/15" : "text-[hsl(0_0%_70%)] hover:bg-[hsl(232_45%_22%)] hover:text-white",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function Loading() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="w-5 h-5 animate-spin text-vs-blue" />
    </div>
  );
}
