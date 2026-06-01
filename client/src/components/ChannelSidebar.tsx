import { Hash, Volume2, ChevronDown, ChevronRight, Plus, Mic, MicOff, Headphones, Settings, Search, Shield, ShieldCheck, Globe, Building2, Users, Lock, ClipboardList, Briefcase, AlertTriangle, FileEdit, MapPin, UserCog, ArrowRightLeft } from "lucide-react";
import { useLocation } from "wouter";
import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Avatar } from "./Avatar";
import { ManageMembersDialog } from "./ManageMembersDialog";
import { MoveChannelDialog } from "./MoveChannelDialog";
import type { ApiChannel, ApiProject, ApiUser } from "@/types/api";

// Phase 1.8: minimal job shape we need to nest channels under jobs in the
// sidebar. Full shape lives on the right-rail / list dialog.
interface SidebarJob {
  id: number;
  kind: "job_site" | "work_project" | "change_order" | "safety_incident";
  ref: string;
  title: string;
  status: string;
  projectId: number | null;
}

interface Props {
  project: ApiProject;
  channels: ApiChannel[];
  projectMembers: ApiUser[];          // for participant pills in voice rows (placeholder: empty in MVP)
  activeChannelId: number | null;
  onSelectChannel: (id: number) => void;
  me: ApiUser;
  myMicMuted: boolean;
  myDeafened: boolean;
  onToggleMic: () => void;
  onToggleDeafen: () => void;
  onCreateChannel?: () => void;
  onOpenWorkObjects?: () => void;
  // Phase 1.8 admin actions need the full company + member lists so the
  // Manage Members and Move Channel dialogs can render the right dropdowns.
  allProjects?: ApiProject[];
  orgMembers?: ApiUser[];
}

export function ChannelSidebar({
  project, channels, projectMembers, activeChannelId, onSelectChannel,
  me, myMicMuted, myDeafened, onToggleMic, onToggleDeafen, onCreateChannel, onOpenWorkObjects,
  allProjects, orgMembers,
}: Props) {
  // Phase 1.8 admin dialogs. Both are admin-gated so we only mount the state
  // when the current user is an admin — avoids accidental opens elsewhere.
  const isAdmin = me.role === "admin";
  const [manageMembersOpen, setManageMembersOpen] = useState(false);
  const [moveChannel, setMoveChannel] = useState<ApiChannel | null>(null);
  // Right-click context menu state for channel rows. Tracks the channel that
  // was right-clicked plus the screen coordinates so the menu pops up under
  // the cursor without us needing a heavier popover lib.
  const [ctxMenu, setCtxMenu] = useState<{ channel: ApiChannel; x: number; y: number } | null>(null);

  // Dismiss the context menu on any outside click / Escape / scroll. Keeps
  // the UX tight — native-feeling without trapping focus.
  useEffect(() => {
    if (!ctxMenu) return;
    const dismiss = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCtxMenu(null); };
    window.addEventListener("click", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);
  // Any signed-in user can create a channel. Visibility is controlled by
  // the scope they pick in the dialog (global / entity / team / private).
  const canCreateChannel = true;

  // Phase 1.8: Jobs for the active company so we can nest channels under
  // them. Hide closed by default — the right-rail list dialog still shows
  // them for archival purposes.
  const jobsQ = useQuery<SidebarJob[]>({
    queryKey: ["/api/work-objects", { projectId: project.id }],
    queryFn: async () => {
      const r = await fetch(`/api/work-objects?projectId=${project.id}`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
  });
  const jobs = useMemo(
    () => (jobsQ.data ?? []).filter(j => (j.projectId ?? null) === project.id),
    [jobsQ.data, project.id],
  );

  // Partition channels by workObjectId. `globalText`/`globalVoice` are the
  // company-wide channels rendered at the top; `byJob` is a lookup map keyed
  // by job id for nested rendering.
  const { globalText, globalVoice, byJob } = useMemo(() => {
    const gt: ApiChannel[] = [];
    const gv: ApiChannel[] = [];
    const map = new Map<number, ApiChannel[]>();
    for (const c of channels) {
      if (c.workObjectId == null) {
        if (c.type === "voice") gv.push(c); else gt.push(c);
      } else {
        const arr = map.get(c.workObjectId) ?? [];
        arr.push(c);
        map.set(c.workObjectId, arr);
      }
    }
    const sortFn = (a: ApiChannel, b: ApiChannel) => a.position - b.position || a.id - b.id;
    gt.sort(sortFn); gv.sort(sortFn);
    for (const arr of map.values()) arr.sort(sortFn);
    return { globalText: gt, globalVoice: gv, byJob: map };
  }, [channels]);

  const [textOpen, setTextOpen] = useState(true);
  const [voiceOpen, setVoiceOpen] = useState(true);
  const [jobsOpen, setJobsOpen] = useState(true);
  const [openJobs, setOpenJobs] = useState<Record<number, boolean>>({});
  const [search, setSearch] = useState("");

  const q = search.toLowerCase();
  const matchText = (c: ApiChannel) => c.name.toLowerCase().includes(q);
  const filteredGlobalText = globalText.filter(matchText);
  const filteredGlobalVoice = globalVoice.filter(matchText);
  // A job is visible while searching if its ref/title matches OR any of its
  // channels match. This way typing "safety" reveals both the safety job
  // and channels named #safety-* under unrelated jobs.
  const visibleJobs = useMemo(() => {
    if (!q) return jobs;
    return jobs.filter(j => {
      if (j.ref.toLowerCase().includes(q) || j.title.toLowerCase().includes(q)) return true;
      const cs = byJob.get(j.id) ?? [];
      return cs.some(matchText);
    });
  }, [jobs, byJob, q]);

  return (
    <aside
      className="flex flex-col w-[240px] shrink-0 vs-navy border-r border-black/40"
      data-testid="sidebar-channels"
    >
      <div className="h-14 px-4 flex items-center justify-between border-b border-black/30 shadow-sm">
        <div className="min-w-0 flex items-center gap-2">
          {/* Phase 1.8: small company badge using the project hue so VFD/VS/
              VTS read at a glance. Switcher itself lives in the left rail. */}
          <span
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[10px] font-bold text-white shrink-0"
            style={{ background: `hsl(${project.hue} 70% 38%)` }}
            aria-hidden
          >
            {project.short || project.name.slice(0, 3).toUpperCase()}
          </span>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.14em] text-vs-red font-bold">Company</div>
            <div className="text-sm font-display text-white truncate" title={project.name} data-testid="text-active-company">
              {project.name}
            </div>
          </div>
        </div>
        {isAdmin ? (
          <button
            type="button"
            onClick={() => setManageMembersOpen(true)}
            className="flex items-center gap-1 text-[hsl(0_0%_65%)] hover:text-white transition-colors px-1.5 py-1 rounded-md hover:bg-[hsl(232_45%_25%)]"
            title={`Manage members of ${project.name}`}
            data-testid="button-manage-members"
          >
            <UserCog className="w-4 h-4" />
          </button>
        ) : (
          <button
            type="button"
            className="text-[hsl(0_0%_65%)] hover:text-white transition-colors p-1"
            title="Company info"
            data-testid="button-project-settings"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="px-3 pt-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(0_0%_50%)]" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search channels"
            className="w-full bg-[hsl(232_60%_9%)] border border-black/40 text-xs text-white placeholder:text-[hsl(0_0%_45%)] rounded-md pl-8 pr-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-vs-red"
            data-testid="input-channel-search"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
        {/* Company-global channels. Rendered above Jobs so #general /
            #announcements are always immediately reachable. */}
        <Section label="Sitrep Channels" open={textOpen} onToggle={() => setTextOpen(!textOpen)} onAdd={canCreateChannel ? onCreateChannel : undefined}>
          {textOpen && filteredGlobalText.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              active={c.id === activeChannelId}
              onClick={() => onSelectChannel(c.id)}
              onContextMenu={isAdmin ? (x, y) => setCtxMenu({ channel: c, x, y }) : undefined}
            />
          ))}
          {textOpen && filteredGlobalText.length === 0 && (
            <div className="px-2 py-1.5 text-[11px] text-[hsl(0_0%_55%)]">No matching channels.</div>
          )}
        </Section>

        <Section label="Net Channels" open={voiceOpen} onToggle={() => setVoiceOpen(!voiceOpen)} onAdd={canCreateChannel ? onCreateChannel : undefined}>
          {voiceOpen && filteredGlobalVoice.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              active={c.id === activeChannelId}
              onClick={() => onSelectChannel(c.id)}
              onContextMenu={isAdmin ? (x, y) => setCtxMenu({ channel: c, x, y }) : undefined}
            />
          ))}
        </Section>

        {/* Jobs section. Each Job is collapsible; channels nest under it.
            Empty Jobs still render so the user knows the job exists and
            can open it from the right rail. */}
        <Section
          label={`Jobs · ${visibleJobs.length}`}
          open={jobsOpen}
          onToggle={() => setJobsOpen(!jobsOpen)}
          onAdd={onOpenWorkObjects}
          addTitle="Open jobs panel"
        >
          {jobsOpen && visibleJobs.length === 0 && (
            <div className="px-2 py-1.5 text-[11px] text-[hsl(0_0%_55%)]">
              {q ? "No matching jobs." : `No jobs in ${project.short || project.name} yet.`}
            </div>
          )}
          {jobsOpen && visibleJobs.map((job) => {
            const expanded = openJobs[job.id] ?? true;
            const jobChannels = (byJob.get(job.id) ?? []).filter(matchText);
            return (
              <JobGroup
                key={job.id}
                job={job}
                expanded={expanded}
                onToggle={() => setOpenJobs(s => ({ ...s, [job.id]: !expanded }))}
                channels={jobChannels}
                activeChannelId={activeChannelId}
                onSelectChannel={onSelectChannel}
                onChannelContextMenu={isAdmin ? (ch, x, y) => setCtxMenu({ channel: ch, x, y }) : undefined}
              />
            );
          })}
        </Section>

        {/* Company-scoped Jobs launcher — opens the dialog filtered to the
            current company. The dialog reads the active company from props. */}
        {onOpenWorkObjects && (
          <div className="pt-1">
            <div className="h-px bg-[hsl(232_40%_22%)] mx-1.5 mb-2" />
            <button
              type="button"
              onClick={onOpenWorkObjects}
              data-testid="button-open-work-objects"
              title={`Every job in ${project.name} — sites, projects, change orders, safety incidents.`}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-[hsl(0_0%_75%)] hover:bg-[hsl(232_45%_25%)] hover:text-white transition-colors"
            >
              <ClipboardList className="w-4 h-4 shrink-0 text-vs-red" />
              <span className="truncate font-medium">All Jobs</span>
              <span className="ml-auto text-[10px] font-mono text-[hsl(0_0%_45%)]">{project.short || "co"}</span>
            </button>
          </div>
        )}
      </div>

      {/* User card */}
      <div className="vs-navy-deep border-t border-black/40 px-2 py-2 flex items-center gap-2">
        <Avatar member={{ name: me.name, hue: me.hue, status: me.status }} size={32} showStatus />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-white truncate" data-testid="text-my-name">{me.name}</div>
          <div className="text-[10px] text-vs-blue-light font-mono uppercase tracking-wider truncate flex items-center gap-1">
            <Shield className="w-2.5 h-2.5" /> {me.title || me.role}
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          <IconBtn title={myMicMuted ? "Unmute" : "Mute"} onClick={onToggleMic} danger={myMicMuted} testid="button-user-mic">
            {myMicMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </IconBtn>
          <IconBtn title={myDeafened ? "Undeafen" : "Deafen"} onClick={onToggleDeafen} danger={myDeafened} testid="button-user-headphones">
            <Headphones className="w-4 h-4" />
          </IconBtn>
          {me.role === "admin" && (
            <AdminBtn />
          )}
          <IconBtn title="User Settings" testid="button-user-settings">
            <Settings className="w-4 h-4" />
          </IconBtn>
        </div>
      </div>

      {/* Phase 1.8 admin: Manage Members dialog. Mounted only for admins so
          non-admins never hold the network/component cost. */}
      {isAdmin && orgMembers && (
        <ManageMembersDialog
          open={manageMembersOpen}
          onClose={() => setManageMembersOpen(false)}
          project={project}
          me={me}
          orgMembers={orgMembers}
        />
      )}

      {/* Phase 1.8 admin: right-click context menu for channel rows. Positions
          itself near the cursor; dismisses on outside click / Escape / scroll. */}
      {isAdmin && ctxMenu && (
        <div
          style={{ position: "fixed", top: ctxMenu.y, left: ctxMenu.x, zIndex: 60 }}
          onClick={(e) => e.stopPropagation()}
          data-testid="context-menu-channel"
          className="min-w-[180px] rounded-md border border-[hsl(232_40%_25%)] bg-[hsl(232_55%_12%)] shadow-2xl overflow-hidden text-sm"
        >
          <button
            type="button"
            onClick={() => { setMoveChannel(ctxMenu.channel); setCtxMenu(null); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-white hover:bg-[hsl(232_45%_22%)]"
            data-testid="menu-item-move-channel"
          >
            <ArrowRightLeft className="w-3.5 h-3.5 text-vs-red" />
            <span>Move channel…</span>
          </button>
          <div className="px-3 py-1.5 text-[10px] text-[hsl(0_0%_50%)] border-t border-[hsl(232_40%_22%)] font-mono">
            #{ctxMenu.channel.name}
          </div>
        </div>
      )}

      {/* Phase 1.8 admin: Move Channel dialog. */}
      {isAdmin && moveChannel && allProjects && (
        <MoveChannelDialog
          open={moveChannel != null}
          onClose={() => setMoveChannel(null)}
          channel={moveChannel}
          projects={allProjects}
        />
      )}
    </aside>
  );
}

function Section({
  label, open, onToggle, onAdd, addTitle, children,
}: { label: string; open: boolean; onToggle: () => void; onAdd?: () => void; addTitle?: string; children: React.ReactNode }) {
  return (
    <div className="group">
      <div className="flex items-center justify-between px-1.5 py-1 text-[10px] uppercase tracking-[0.16em] font-bold text-[hsl(0_0%_55%)]">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1 hover:text-white transition-colors"
        >
          <ChevronDown className={`w-3 h-3 transition-transform ${open ? "" : "-rotate-90"}`} />
          {label}
        </button>
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            title={addTitle ?? "New channel"}
            data-testid="button-new-channel"
            className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-white"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <div className="mt-1 space-y-0.5">{children}</div>
    </div>
  );
}

function jobKindIcon(kind: SidebarJob["kind"]) {
  if (kind === "job_site") return MapPin;
  if (kind === "work_project") return Briefcase;
  if (kind === "change_order") return FileEdit;
  return AlertTriangle; // safety_incident
}

function JobGroup({
  job, expanded, onToggle, channels, activeChannelId, onSelectChannel, onChannelContextMenu,
}: {
  job: SidebarJob;
  expanded: boolean;
  onToggle: () => void;
  channels: ApiChannel[];
  activeChannelId: number | null;
  onSelectChannel: (id: number) => void;
  onChannelContextMenu?: (channel: ApiChannel, x: number, y: number) => void;
}) {
  const Icon = jobKindIcon(job.kind);
  const isClosed = job.status === "closed";
  return (
    <div className="mb-1" data-testid={`job-group-${job.id}`}>
      <button
        type="button"
        onClick={onToggle}
        title={`${job.ref} — ${job.title}`}
        className={[
          "w-full flex items-center gap-1.5 px-1.5 py-1 rounded-md text-[12px] text-left transition-colors",
          isClosed ? "text-[hsl(0_0%_50%)]" : "text-[hsl(0_0%_80%)] hover:text-white",
          "hover:bg-[hsl(232_45%_22%)]",
        ].join(" ")}
      >
        {expanded
          ? <ChevronDown className="w-3 h-3 shrink-0 text-[hsl(0_0%_55%)]" />
          : <ChevronRight className="w-3 h-3 shrink-0 text-[hsl(0_0%_55%)]" />}
        <Icon className="w-3.5 h-3.5 shrink-0 text-vs-red" />
        <span className="font-mono text-[10px] tracking-tight text-vs-blue-light shrink-0">{job.ref}</span>
        <span className="truncate font-medium">{job.title}</span>
        {isClosed && <span className="ml-1 text-[9px] uppercase text-[hsl(0_0%_45%)]">closed</span>}
      </button>
      {expanded && (
        <div className="ml-3 mt-0.5 pl-1 border-l border-[hsl(232_40%_22%)] space-y-0.5">
          {channels.length === 0 && (
            <div className="px-2 py-1 text-[10px] text-[hsl(0_0%_45%)]">No channels in this job yet.</div>
          )}
          {channels.map(c => (
            <ChannelRow
              key={c.id}
              channel={c}
              active={c.id === activeChannelId}
              onClick={() => onSelectChannel(c.id)}
              onContextMenu={onChannelContextMenu ? (x, y) => onChannelContextMenu(c, x, y) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChannelRow({
  channel, active, onClick, onContextMenu,
}: { channel: ApiChannel; active: boolean; onClick: () => void; onContextMenu?: (x: number, y: number) => void }) {
  const Icon = channel.type === "voice" ? Volume2 : Hash;
  // Subtle indicator that surfaces scope without taking row real estate.
  // Hidden for the default 'global' scope to avoid clutter.
  const scope = channel.scope ?? "global";
  const ScopeIcon = scope === "entity" ? Building2
    : scope === "team" ? Users
    : scope === "private" ? Lock
    : Globe;
  const scopeTitle = scope === "entity" ? `Entity: ${channel.entityId ?? ""}`
    : scope === "team" ? `Team: ${channel.teamRole ?? ""}`
    : scope === "private" ? "Private channel"
    : "Global channel";
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e.clientX, e.clientY); } : undefined}
      data-testid={`channel-${channel.id}`}
      className={[
        "relative w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors group",
        active ? "bg-[hsl(232_45%_30%)] text-white" : "text-[hsl(0_0%_75%)] hover:bg-[hsl(232_45%_25%)] hover:text-white",
      ].join(" ")}
    >
      {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-vs-red" />}
      <Icon className={`w-4 h-4 shrink-0 ${active ? "text-vs-red" : "text-[hsl(0_0%_50%)]"}`} />
      <span className="truncate font-medium">{channel.name}</span>
      {scope !== "global" && (
        <ScopeIcon
          className="w-3 h-3 shrink-0 ml-auto text-[hsl(0_0%_45%)] group-hover:text-[hsl(0_0%_70%)]"
          aria-label={scopeTitle}
        />
      )}
    </button>
  );
}

function IconBtn({
  children, title, onClick, danger, testid,
}: { children: React.ReactNode; title: string; onClick?: () => void; danger?: boolean; testid?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-testid={testid}
      className={[
        "w-8 h-8 flex items-center justify-center rounded-md transition-colors",
        danger ? "text-vs-red hover:bg-[hsl(2_70%_55%/0.15)]" : "text-[hsl(0_0%_65%)] hover:text-white hover:bg-[hsl(232_45%_30%)]",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function AdminBtn() {
  const [, setLocation] = useLocation();
  return (
    <button
      type="button"
      onClick={() => setLocation("/admin")}
      title="Admin Panel"
      data-testid="button-admin-panel"
      className="w-8 h-8 flex items-center justify-center rounded-md transition-colors text-vs-red hover:bg-[hsl(2_70%_55%/0.15)]"
    >
      <ShieldCheck className="w-4 h-4" />
    </button>
  );
}
