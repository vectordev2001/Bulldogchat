import { Hash, ChevronDown, ChevronRight, Plus, Mic, MicOff, Headphones, Settings, Search, Shield, ShieldCheck, Globe, Building2, Users, Lock, ClipboardList, Briefcase, AlertTriangle, FileEdit, MapPin, UserCog, ArrowRightLeft, Trash2, Calendar } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Avatar } from "./Avatar";
import { ManageMembersDialog } from "./ManageMembersDialog";
import { MoveChannelDialog } from "./MoveChannelDialog";
import { DmSection } from "./DmSection";
import type { ApiChannel, ApiProject, ApiUser, ApiRegion } from "@/types/api";

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
  // Opens the create-channel dialog with a job preselected (from a job row's
  // "New channel under …" context-menu action).
  onCreateChannelInJob?: (jobId: number) => void;
  onOpenWorkObjects?: () => void;
  // Phase 1.9.1 — opens the Meetings list dialog (upcoming/past scheduled calls).
  onOpenMeetings?: () => void;
  // Phase 1.8 admin actions need the full company + member lists so the
  // Manage Members and Move Channel dialogs can render the right dropdowns.
  allProjects?: ApiProject[];
  orgMembers?: ApiUser[];
  // Phase 1.9.1: DM section state. DMs live above Jobs/Channels and are
  // project-agnostic, so the parent owns the selection and we just render
  // the section + bubble taps back up.
  activeDmId?: number | null;
  onSelectDm?: (dmId: number) => void;
}

export function ChannelSidebar({
  project, channels, projectMembers, activeChannelId, onSelectChannel,
  me, myMicMuted, myDeafened, onToggleMic, onToggleDeafen, onCreateChannel, onCreateChannelInJob, onOpenWorkObjects,
  onOpenMeetings,
  allProjects, orgMembers, activeDmId, onSelectDm,
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
  // Parallel context menu for Job rows — same shape/behavior as the channel
  // menu, but the action deletes the whole job (and its nested channels).
  const [jobCtxMenu, setJobCtxMenu] = useState<{ job: SidebarJob; x: number; y: number } | null>(null);

  // Dismiss the context menu on any outside click / Escape / scroll. Keeps
  // the UX tight — native-feeling without trapping focus. Covers both the
  // channel and job context menus.
  useEffect(() => {
    if (!ctxMenu && !jobCtxMenu) return;
    const dismiss = () => { setCtxMenu(null); setJobCtxMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    window.addEventListener("click", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu, jobCtxMenu]);
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

  // Multi-tenant Option A: regions for this company. Server returns only the
  // regions the user has at least one grant for (or all for a whole-project
  // / super-admin grant), so we render them directly.
  const regionsQ = useQuery<ApiRegion[]>({
    queryKey: ["/api/projects", project.id, "regions"],
    queryFn: async () => {
      const r = await fetch(`/api/projects/${project.id}/regions`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
  });
  const regions = regionsQ.data ?? [];

  // Phase 1.9 + multi-tenant: split channels into (a) company-wide
  // (regionId=NULL, workObjectId=NULL), (b) per-region groups, and (c)
  // job-nested groups. Channels with a regionId render under their region.
  const { companyWideChannels, byRegion, byJob } = useMemo(() => {
    const companyWide: ApiChannel[] = [];
    const region = new Map<number, ApiChannel[]>();
    const job = new Map<number, ApiChannel[]>();
    for (const c of channels) {
      if (c.workObjectId != null) {
        const arr = job.get(c.workObjectId) ?? [];
        arr.push(c);
        job.set(c.workObjectId, arr);
        continue;
      }
      if (c.regionId != null) {
        const arr = region.get(c.regionId) ?? [];
        arr.push(c);
        region.set(c.regionId, arr);
        continue;
      }
      companyWide.push(c);
    }
    const sortFn = (a: ApiChannel, b: ApiChannel) => a.position - b.position || a.id - b.id;
    companyWide.sort(sortFn);
    for (const arr of region.values()) arr.sort(sortFn);
    for (const arr of job.values()) arr.sort(sortFn);
    return { companyWideChannels: companyWide, byRegion: region, byJob: job };
  }, [channels]);

  const [textOpen, setTextOpen] = useState(true);
  const [jobsOpen, setJobsOpen] = useState(true);
  const [openJobs, setOpenJobs] = useState<Record<number, boolean>>({});
  const [search, setSearch] = useState("");

  // Per-region open/closed state. Default to open so users see their
  // channels on first load; persists across re-renders within the session.
  const [openRegions, setOpenRegions] = useState<Record<number, boolean>>({});

  const q = search.toLowerCase();
  const matchText = (c: ApiChannel) => c.name.toLowerCase().includes(q);
  const filteredCompanyWide = companyWideChannels.filter(matchText);
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
      className="flex flex-col w-[240px] shrink-0 bg-sidebar border-r border-border"
      data-testid="sidebar-channels"
    >
      <div className="h-14 px-4 flex items-center justify-between border-b border-border shadow-sm">
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
            <div className="text-[10px] uppercase tracking-[0.14em] text-vs-accent font-bold">Company</div>
            <div className="text-sm font-display text-[hsl(var(--vs-text))] truncate" title={project.name} data-testid="text-active-company">
              {project.name}
            </div>
          </div>
        </div>
        {isAdmin ? (
          <button
            type="button"
            onClick={() => setManageMembersOpen(true)}
            className="flex items-center gap-1 text-[hsl(var(--vs-text-muted))] hover:text-[hsl(var(--vs-accent))] transition-colors px-1.5 py-1 rounded-md hover:bg-[hsl(var(--vs-accent-soft))]"
            title={`Manage members of ${project.name}`}
            data-testid="button-manage-members"
          >
            <UserCog className="w-4 h-4" />
          </button>
        ) : (
          <button
            type="button"
            className="text-[hsl(var(--vs-text-muted))] hover:text-[hsl(var(--vs-accent))] transition-colors p-1"
            title="Company info"
            data-testid="button-project-settings"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="px-3 pt-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(var(--vs-text-subtle))]" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search channels"
            className="w-full bg-background border border-input text-xs text-foreground placeholder:text-[hsl(var(--vs-text-subtle))] rounded-md pl-8 pr-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[hsl(var(--vs-accent))]"
            data-testid="input-channel-search"
          />
        </div>
      </div>

      {/* Phase 1.9.32 — Meetings pinned above the scrollable jobs/channels list
          so it's always reachable without scrolling past every job and channel.
          Lives between the search bar and the scroll region. */}
      {onOpenMeetings && (
        <div className="px-2 pt-2">
          <button
            type="button"
            onClick={onOpenMeetings}
            data-testid="button-open-meetings-top"
            title="Upcoming and recent Bulldog calls—schedule a new one or RSVP."
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-[hsl(var(--vs-text))] bg-secondary hover:bg-[hsl(var(--vs-accent-soft))] transition-colors"
          >
            <Calendar className="w-4 h-4 shrink-0 text-vs-accent" />
            <span className="truncate font-medium">Meetings</span>
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
        {/* Direct Messages — pinned at the TOP of the sidebar above Jobs and
            global Channels. DMs are project-agnostic; the section lives here
            so it's always one tap away no matter which company is active. */}
        {onSelectDm && (
          <DmSection
            me={me}
            orgMembers={orgMembers ?? []}
            activeDmId={activeDmId ?? null}
            onSelectDm={onSelectDm}
          />
        )}

        {/* Jobs section — Josh wants active work front-and-center.
            Each Job is collapsible; channels nest under it. Empty Jobs
            still render so the user knows the job exists and can open it
            from the right rail. */}
        <Section
          label={`Jobs · ${visibleJobs.length}`}
          open={jobsOpen}
          onToggle={() => setJobsOpen(!jobsOpen)}
          onAdd={onOpenWorkObjects}
          addTitle="Open jobs panel"
        >
          {jobsOpen && visibleJobs.length === 0 && (
            <div className="px-2 py-1.5 text-[11px] text-[hsl(var(--vs-text-subtle))]">
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
                onJobContextMenu={isAdmin ? (j, x, y) => setJobCtxMenu({ job: j, x, y }) : undefined}
              />
            );
          })}
        </Section>

        {/* Company-wide channels (regionId=NULL, e.g. #announcements). */}
        <Section label="Company-wide" open={textOpen} onToggle={() => setTextOpen(!textOpen)} onAdd={canCreateChannel ? onCreateChannel : undefined}>
          {textOpen && filteredCompanyWide.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              active={c.id === activeChannelId}
              onClick={() => onSelectChannel(c.id)}
              onContextMenu={isAdmin ? (x, y) => setCtxMenu({ channel: c, x, y }) : undefined}
            />
          ))}
          {textOpen && filteredCompanyWide.length === 0 && (
            <div className="px-2 py-1.5 text-[11px] text-[hsl(var(--vs-text-subtle))]">No matching channels.</div>
          )}
        </Section>

        {/* Multi-tenant: per-region groups. Each region is its own
            collapsible section. Hidden during search when empty so the
            sidebar collapses to just the matching companies. */}
        {regions.map((reg) => {
          const open = openRegions[reg.id] ?? true;
          const regionChannels = (byRegion.get(reg.id) ?? []).filter(matchText);
          if (q && regionChannels.length === 0) return null;
          return (
            <Section
              key={reg.id}
              label={`${reg.code} · ${reg.name}`}
              open={open}
              onToggle={() => setOpenRegions(s => ({ ...s, [reg.id]: !open }))}
              onAdd={canCreateChannel ? onCreateChannel : undefined}
              addTitle={`New channel in ${reg.name}`}
            >
              {open && regionChannels.map((c) => (
                <ChannelRow
                  key={c.id}
                  channel={c}
                  active={c.id === activeChannelId}
                  onClick={() => onSelectChannel(c.id)}
                  onContextMenu={isAdmin ? (x, y) => setCtxMenu({ channel: c, x, y }) : undefined}
                  regionBadge={reg.code}
                />
              ))}
              {open && regionChannels.length === 0 && (
                <div className="px-2 py-1.5 text-[11px] text-[hsl(var(--vs-text-subtle))]">No channels in this region.</div>
              )}
            </Section>
          );
        })}

        {/* Company-scoped Jobs launcher — opens the dialog filtered to the
            current company. The dialog reads the active company from props. */}
        {onOpenWorkObjects && (
          <div className="pt-1">
            <div className="h-px bg-border mx-1.5 mb-2" />
            <button
              type="button"
              onClick={onOpenWorkObjects}
              data-testid="button-open-work-objects"
              title={`Every job in ${project.name} — sites, projects, change orders, safety incidents.`}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-[hsl(var(--vs-text-muted))] hover:bg-[hsl(var(--vs-accent-soft))] hover:text-[hsl(var(--vs-accent))] transition-colors"
            >
              <ClipboardList className="w-4 h-4 shrink-0 text-vs-accent" />
              <span className="truncate font-medium">All Jobs</span>
              <span className="ml-auto text-[10px] font-mono text-[hsl(var(--vs-text-subtle))]">{project.short || "co"}</span>
            </button>
          </div>
        )}

        {/* Phase 1.9.32 — Meetings launcher moved to the pinned area above
            the scroll region. The button there has the same handler. */}
      </div>

      {/* User card */}
      <div className="bg-secondary border-t border-border px-2 py-2 flex items-center gap-2">
        <Avatar member={{ name: me.name, hue: me.hue, status: me.status }} size={32} showStatus />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-[hsl(var(--vs-text))] truncate" data-testid="text-my-name">{me.name}</div>
          <div className="text-[10px] text-vs-accent font-mono uppercase tracking-wider truncate flex items-center gap-1">
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
          className="min-w-[180px] rounded-md border border-popover-border bg-popover shadow-2xl overflow-hidden text-sm"
        >
          <button
            type="button"
            onClick={() => { setMoveChannel(ctxMenu.channel); setCtxMenu(null); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-popover-foreground hover:bg-accent"
            data-testid="menu-item-move-channel"
          >
            <ArrowRightLeft className="w-3.5 h-3.5 text-vs-accent" />
            <span>Move channel…</span>
          </button>
          <button
            type="button"
            onClick={async () => {
              const ch = ctxMenu.channel;
              setCtxMenu(null);
              const ok = window.confirm(
                `Delete channel #${ch.name}?\n\nThis permanently removes every message, reaction, mention, read receipt, member grant, recording, and call room for this channel. Cannot be undone.`,
              );
              if (!ok) return;
              try {
                await apiRequest("DELETE", `/api/channels/${ch.id}`);
                // Refresh sidebar lists. Invalidate both project channels and the
                // job-scoped channel lists so right-rail/job groups update too.
                queryClient.invalidateQueries({ queryKey: ["/api/projects", project.id, "channels"] });
                queryClient.invalidateQueries({ queryKey: ["/api/work-objects"] });
                // If the deleted channel was active, kick selection back to
                // the company's first remaining channel (Home owns selection,
                // so emit a soft hint via custom event the parent listens for).
                if (activeChannelId === ch.id) {
                  window.dispatchEvent(new CustomEvent("chat:channel-deleted", { detail: { channelId: ch.id } }));
                }
              } catch (err) {
                console.error("[delete-channel]", err);
                window.alert("Failed to delete channel. Check the console for details.");
              }
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-[hsl(var(--vs-danger))] hover:bg-destructive/10 hover:text-[hsl(var(--vs-danger))]"
            data-testid="menu-item-delete-channel"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Delete channel…</span>
          </button>
          <div className="px-3 py-1.5 text-[10px] text-[hsl(var(--vs-text-subtle))] border-t border-border font-mono">
            #{ctxMenu.channel.name}
          </div>
        </div>
      )}

      {/* Admin: right-click context menu for Job rows. Mirrors the channel
          menu; deletes the whole job (and every channel nested under it). */}
      {isAdmin && jobCtxMenu && (
        <div
          style={{ position: "fixed", top: jobCtxMenu.y, left: jobCtxMenu.x, zIndex: 60 }}
          onClick={(e) => e.stopPropagation()}
          data-testid="context-menu-job"
          className="min-w-[180px] rounded-md border border-popover-border bg-popover shadow-2xl overflow-hidden text-sm"
        >
          <button
            type="button"
            onClick={() => {
              const jobId = jobCtxMenu.job.id;
              setJobCtxMenu(null);
              onCreateChannelInJob?.(jobId);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent"
            data-testid="menu-item-new-channel-in-job"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="truncate">New channel under {jobCtxMenu.job.ref}</span>
          </button>
          <button
            type="button"
            onClick={async () => {
              const job = jobCtxMenu.job;
              setJobCtxMenu(null);
              const ok = window.confirm(
                `Delete job ${job.ref} — “${job.title}”?\n\nThis permanently deletes the job AND every channel nested under it, along with all messages, reactions, mentions, read receipts, member grants, recordings, and call rooms in those channels. Cannot be undone.`,
              );
              if (!ok) return;
              try {
                await apiRequest("DELETE", `/api/work-objects/${job.id}`);
                queryClient.invalidateQueries({ queryKey: ["/api/work-objects"] });
                queryClient.invalidateQueries({ queryKey: ["/api/channels"] });
              } catch (err) {
                console.error("[delete-job]", err);
                window.alert("Failed to delete job. Check the console for details.");
              }
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-[hsl(var(--vs-danger))] hover:bg-destructive/10 hover:text-[hsl(var(--vs-danger))]"
            data-testid="menu-item-delete-job"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Delete job…</span>
          </button>
          <div className="px-3 py-1.5 text-[10px] text-[hsl(var(--vs-text-subtle))] border-t border-border font-mono">
            {jobCtxMenu.job.ref}
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
      <div className="flex items-center justify-between px-1.5 py-1 text-[10px] uppercase tracking-[0.16em] font-bold text-[hsl(var(--vs-text-subtle))]">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1 hover:text-[hsl(var(--vs-text))] transition-colors"
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
            className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-[hsl(var(--vs-accent))]"
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
  job, expanded, onToggle, channels, activeChannelId, onSelectChannel, onChannelContextMenu, onJobContextMenu,
}: {
  job: SidebarJob;
  expanded: boolean;
  onToggle: () => void;
  channels: ApiChannel[];
  activeChannelId: number | null;
  onSelectChannel: (id: number) => void;
  onChannelContextMenu?: (channel: ApiChannel, x: number, y: number) => void;
  onJobContextMenu?: (job: SidebarJob, x: number, y: number) => void;
}) {
  const Icon = jobKindIcon(job.kind);
  const isClosed = job.status === "closed";
  return (
    <div className="mb-1" data-testid={`job-group-${job.id}`}>
      <button
        type="button"
        onClick={onToggle}
        onContextMenu={onJobContextMenu ? (e) => { e.preventDefault(); onJobContextMenu(job, e.clientX, e.clientY); } : undefined}
        title={`${job.ref} — ${job.title}`}
        className={[
          "w-full flex items-center gap-1.5 px-1.5 py-1 rounded-md text-[12px] text-left transition-colors",
          isClosed ? "text-[hsl(var(--vs-text-subtle))]" : "text-[hsl(var(--vs-text-muted))] hover:text-[hsl(var(--vs-text))]",
          "hover:bg-[hsl(var(--vs-accent-soft))]",
        ].join(" ")}
      >
        {expanded
          ? <ChevronDown className="w-3 h-3 shrink-0 text-[hsl(var(--vs-text-subtle))]" />
          : <ChevronRight className="w-3 h-3 shrink-0 text-[hsl(var(--vs-text-subtle))]" />}
        <Icon className="w-3.5 h-3.5 shrink-0 text-vs-accent" />
        <span className="font-mono text-[10px] tracking-tight text-vs-blue-deep shrink-0">{job.ref}</span>
        <span className="truncate font-medium">{job.title}</span>
        {isClosed && <span className="ml-1 text-[9px] uppercase text-[hsl(var(--vs-text-subtle))]">closed</span>}
      </button>
      {expanded && (
        <div className="ml-3 mt-0.5 pl-1 border-l border-border space-y-0.5">
          {channels.length === 0 && (
            <div className="px-2 py-1 text-[10px] text-[hsl(var(--vs-text-subtle))]">No channels in this job yet.</div>
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
  channel, active, onClick, onContextMenu, regionBadge,
}: { channel: ApiChannel; active: boolean; onClick: () => void; onContextMenu?: (x: number, y: number) => void; regionBadge?: string }) {
  // Phase 1.9: every channel renders with the # icon. The phone/video
  // buttons live in the channel header (TextChannelView).
  const Icon = Hash;
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
        active ? "bg-[hsl(var(--vs-accent-soft))] text-[hsl(var(--vs-accent))]" : "text-[hsl(var(--vs-text-muted))] hover:bg-[hsl(var(--vs-accent-soft))] hover:text-[hsl(var(--vs-text))]",
      ].join(" ")}
    >
      {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-vs-accent" />}
      <Icon className={`w-4 h-4 shrink-0 ${active ? "text-vs-accent" : "text-[hsl(var(--vs-text-subtle))]"}`} />
      <span className="truncate font-medium">{channel.name}</span>
      {regionBadge && (
        <span
          className="ml-auto inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-[hsl(var(--vs-accent-soft))] text-vs-accent shrink-0"
          title={`Region: ${regionBadge}`}
          aria-label={`Region ${regionBadge}`}
        >
          {regionBadge}
        </span>
      )}
      {scope !== "global" && (
        <ScopeIcon
          className={`w-3 h-3 shrink-0 ${regionBadge ? "" : "ml-auto"} text-[hsl(var(--vs-text-subtle))] group-hover:text-[hsl(var(--vs-text-muted))]`}
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
        danger ? "text-vs-danger hover:bg-destructive/10" : "text-[hsl(var(--vs-text-muted))] hover:text-[hsl(var(--vs-accent))] hover:bg-[hsl(var(--vs-accent-soft))]",
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
      className="w-8 h-8 flex items-center justify-center rounded-md transition-colors text-vs-accent hover:bg-[hsl(var(--vs-accent-soft))]"
    >
      <ShieldCheck className="w-4 h-4" />
    </button>
  );
}
