import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Menu, X, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/lib/auth";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useSSE } from "@/hooks/use-sse";
import { ProjectRail } from "@/components/ProjectRail";
import { ChannelSidebar } from "@/components/ChannelSidebar";
import { CreateChannelDialog } from "@/components/CreateChannelDialog";
import { TextChannelView } from "@/components/TextChannelView";
import { MemberList } from "@/components/MemberList";
import { WorkObjectPanel } from "@/components/WorkObjectPanel";
import { WorkObjectsListDialog } from "@/components/WorkObjectsListDialog";
import { ScheduleCallDialog, MeetingsListDialog } from "@/components/ScheduleCallDialog";
import { VectorLogo } from "@/components/VectorLogo";
import type { ApiProject, ApiChannel, ApiMessage, ApiUser } from "@/types/api";

export default function Home() {
  const { user } = useAuth();

  // Project + channel selection
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [channelByProject, setChannelByProject] = useState<Record<number, number>>({});
  // Phase 1.9.1: Active DM selection. When non-null we render the DM thread
  // INSTEAD of the project channel — DMs are a parallel "view" that lives
  // above Jobs in the sidebar. Selecting a project channel clears the DM,
  // and selecting a DM doesn't disturb the per-project channel slot so the
  // user can hop back to where they were.
  const [activeDmId, setActiveDmId] = useState<number | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  // Right-rail members list. Default to closed on mobile so the drawer
  // never auto-pops on iPhone; open on desktop (≥md) so the static
  // sidebar shows by default. Re-evaluated once on mount; user toggles
  // it after that via the header Users icon.
  const [membersOpen, setMembersOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return window.matchMedia("(min-width: 768px)").matches; } catch { return false; }
  });
  // Right-rail work objects panel — opt-in; toggled from channel header.
  const [workObjectsOpen, setWorkObjectsOpen] = useState(false);
  // Org-wide Work Objects list modal — launched from sidebar.
  const [workObjectsListOpen, setWorkObjectsListOpen] = useState(false);
  // Phase 1.9.1 — Scheduled calls (Meetings) UI.
  // scheduleOpen: the new-meeting modal. meetingsOpen: the upcoming/past list.
  // scheduleHint/scheduleChannelId: pre-fill values when launched from the
  // /schedule slash command in a channel.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [meetingsOpen, setMeetingsOpen] = useState(false);
  const [scheduleHint, setScheduleHint] = useState<string>("");
  const [scheduleChannelId, setScheduleChannelId] = useState<number | null>(null);

  // Self-call state
  // Default to muted on iOS so we never fire getUserMedia({audio:true})
  // outside a user-gesture context — doing so freezes the iOS WebView.
  // On desktop/Android we keep the existing auto-unmute behavior.
  const [myMicMuted, setMyMicMuted] = useState(() => {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) ||
      (ua.includes("Mac") && (navigator as any).maxTouchPoints > 1);
    return isIOS; // muted on iOS, unmuted elsewhere
  });
  const [myDeafened, setMyDeafened] = useState(false);
  // (Phase 1.9) Video/screen/hand state is now owned by ChannelCallDialog
  // — we don't pre-allocate it at the page level any more.

  // --- Queries ---
  const projectsQ = useQuery<ApiProject[]>({
    queryKey: ["/api/projects"],
    enabled: !!user,
  });

  const membersQ = useQuery<ApiUser[]>({
    queryKey: ["/api/org/members"],
    enabled: !!user,
    // Refetch every 30s so the roster's online/offline state stays
    // accurate. Presence is server-derived from lastSeenAt, so polling
    // is how the client picks up that someone went idle.
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    // Also refetch when the user comes back to the tab — common case
    // where someone left for an hour and the roster looks stale.
    refetchOnWindowFocus: true,
  });

  // Deep-link: ?channel=<id> — fired by contracts "Create chat meeting" button.
  // Run once on mount; resolve the channel, jump to its project, select it, then
  // strip the param so a refresh doesn't keep re-applying it.
  const [deepLinkPending, setDeepLinkPending] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return new URL(window.location.href).searchParams.has("channel");
  });
  useEffect(() => {
    if (!deepLinkPending) return;
    const url = new URL(window.location.href);
    const raw = url.searchParams.get("channel");
    const channelId = raw ? Number(raw) : NaN;
    if (!Number.isFinite(channelId)) {
      setDeepLinkPending(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const ch = await apiRequest<{ id: number; projectId: number }>(
          "GET",
          `/api/channels/${channelId}`,
        );
        if (cancelled || !ch?.projectId) return;
        setActiveProjectId(ch.projectId);
        setChannelByProject((prev) => ({ ...prev, [ch.projectId]: ch.id }));
      } catch {
        /* fall through to default project */
      } finally {
        if (!cancelled) {
          url.searchParams.delete("channel");
          window.history.replaceState({}, "", url.pathname + (url.search ? url.search : "") + url.hash);
          setDeepLinkPending(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deepLinkPending]);

  // Pick a default project once data is loaded.
  // Skip while a deep-link is still resolving so we don't briefly land on #general.
  useEffect(() => {
    if (deepLinkPending) return;
    if (!activeProjectId && projectsQ.data && projectsQ.data.length > 0) {
      setActiveProjectId(projectsQ.data[0].id);
    }
  }, [projectsQ.data, activeProjectId, deepLinkPending]);

  const channelsQ = useQuery<ApiChannel[]>({
    queryKey: ["/api/projects", activeProjectId, "channels"],
    enabled: !!activeProjectId,
  });

  // Default-select first text channel for the active project.
  // Use sentinel value -1 when the project has no channels at all,
  // so the render conditional can show an empty state instead of
  // spinning forever waiting for an activeChannel that will never exist.
  useEffect(() => {
    if (!activeProjectId || !channelsQ.data) return;
    if (channelByProject[activeProjectId]) return;
    const sorted = [...channelsQ.data].sort((a, b) => a.position - b.position);
    const firstText = sorted.find((c) => c.type === "text") ?? sorted[0];
    setChannelByProject((prev) => ({
      ...prev,
      [activeProjectId]: firstText ? firstText.id : -1,
    }));
  }, [activeProjectId, channelsQ.data, channelByProject]);

  const activeChannelId = activeProjectId ? channelByProject[activeProjectId] ?? null : null;
  const activeChannel: ApiChannel | undefined = useMemo(
    () => channelsQ.data?.find((c) => c.id === activeChannelId),
    [channelsQ.data, activeChannelId],
  );
  const activeProject: ApiProject | undefined = useMemo(
    () => projectsQ.data?.find((p) => p.id === activeProjectId),
    [projectsQ.data, activeProjectId],
  );

  const messagesQ = useQuery<ApiMessage[]>({
    queryKey: ["/api/channels", activeChannelId, "messages"],
    enabled: !!activeChannelId && activeChannel?.type === "text" && !activeDmId,
  });

  // When a DM is active, fetch the DM channel row (by id) and its messages.
  // We reuse the standard channel endpoints — a DM is a channel with
  // scope='dm' on the server. The channel fetch makes sure TextChannelView
  // gets the same ApiChannel shape it expects.
  const dmChannelQ = useQuery<ApiChannel>({
    queryKey: ["/api/channels", activeDmId],
    queryFn: () => apiRequest<ApiChannel>("GET", `/api/channels/${activeDmId}`),
    enabled: !!activeDmId,
  });
  const dmMessagesQ = useQuery<ApiMessage[]>({
    queryKey: ["/api/channels", activeDmId, "messages"],
    enabled: !!activeDmId,
  });

  // SSE: invalidate messages on relevant events. New DM messages also kick
  // the DM list query so the sender re-sorts to the top of the section.
  const sseStatus = useSSE(!!user, {
    onMessageNew: (data) => {
      if (data?.channelId) {
        queryClient.invalidateQueries({ queryKey: ["/api/channels", data.channelId, "messages"] });
        // Cheap: always poke the DM list. The server returns 0 rows for
        // users who aren't in any DM channel, so the cost is negligible.
        queryClient.invalidateQueries({ queryKey: ["/api/dms"] });
      }
    },
    onMessageUpdate: (data) => {
      if (data?.channelId) {
        queryClient.invalidateQueries({ queryKey: ["/api/channels", data.channelId, "messages"] });
      }
    },
    onMessageDelete: (data) => {
      if (data?.channelId) {
        queryClient.invalidateQueries({ queryKey: ["/api/channels", data.channelId, "messages"] });
      }
    },
    onReactionChange: (data) => {
      if (data?.channelId) {
        queryClient.invalidateQueries({ queryKey: ["/api/channels", data.channelId, "messages"] });
      }
    },
    // Phase 1.9.1: when a DM or channel is deleted, bail the user out of
    // that view (otherwise they'd be staring at a 404) and refresh the
    // sidebar lists so the row disappears.
    onChannelDelete: (data) => {
      const cid = data?.channelId;
      if (!cid) return;
      if (activeDmId === cid) {
        setActiveDmId(null);
      }
      // If the active project's channel was deleted, clear that slot so
      // the project view falls back to its first remaining channel.
      setChannelByProject((prev) => {
        const next: typeof prev = {};
        let touched = false;
        for (const [pid, chId] of Object.entries(prev)) {
          if (chId === cid) { touched = true; continue; }
          next[Number(pid)] = chId;
        }
        return touched ? next : prev;
      });
      queryClient.invalidateQueries({ queryKey: ["/api/dms"] });
      queryClient.invalidateQueries({ queryKey: ["/api/channels"] });
      // Drop cached messages for the gone channel.
      queryClient.removeQueries({ queryKey: ["/api/channels", cid] });
    },
  });

  const selectProject = (id: number) => {
    setActiveProjectId(id);
    setActiveDmId(null); // Hopping into a company — leave the DM view.
    setMobileNavOpen(false);
  };
  const selectChannel = (id: number) => {
    if (activeProjectId == null) return;
    setChannelByProject((prev) => ({ ...prev, [activeProjectId]: id }));
    setActiveDmId(null); // Picked a channel — leave the DM view.
    setMobileNavOpen(false);
  };
  const selectDm = (id: number) => {
    setActiveDmId(id);
    setMobileNavOpen(false);
  };

  // Phase 1.9: Escape-to-text behavior is no longer needed — every channel
  // is now a text channel that can optionally host a call. The Escape key
  // is handled by ChannelCallDialog when a call is active.

  // Loading state
  if (!user) return null;
  if (projectsQ.isLoading || membersQ.isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[hsl(232_60%_9%)] text-white gap-4">
        <VectorLogo size={56} className="text-vs-blue" monochrome />
        <Loader2 className="w-5 h-5 animate-spin text-vs-blue" />
        <p className="text-sm text-white/60">Loading Bulldog Chat…</p>
      </div>
    );
  }

  if (projectsQ.error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[hsl(232_60%_9%)] text-white gap-3 p-6 text-center">
        <VectorLogo size={48} className="text-vs-blue" monochrome />
        <h1 className="text-lg font-display">Could not load projects</h1>
        <p className="text-sm text-white/60 max-w-md">{(projectsQ.error as Error).message}</p>
      </div>
    );
  }

  const projects = projectsQ.data ?? [];
  const channels = channelsQ.data ?? [];
  const members = membersQ.data ?? [];

  // Empty state — no projects
  if (projects.length === 0) {
    return (
      <div className="min-h-screen flex bg-[hsl(232_60%_9%)] text-white">
        <ProjectRail
          projects={[]}
          activeId={null}
          onSelect={() => {}}
          sseStatus={sseStatus}
        />
        <main className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
          <VectorLogo size={64} className="text-vs-blue" monochrome />
          <h1 className="text-xl font-display">No projects yet</h1>
          <p className="text-sm text-white/60 max-w-md">
            Admins can create a project to get the team talking. Once a project exists, channels and
            messages show up here.
          </p>
        </main>
      </div>
    );
  }

  return (
    // Fill the parent (#root) which is already sized to 100dvh minus iOS
    // safe-area-inset-top/bottom via body padding (see index.css). Using
    // h-full — NOT h-[100dvh] — is critical on iPhone PWAs: h-[100dvh]
    // forces the box to 100dvh INSIDE a parent that is already shorter,
    // pushing the bottom call-controls bar off-screen below the home
    // indicator. h-full matches the parent and keeps every pinned bar
    // (composer toolbar, call controls) visible.
    // overflow-hidden forces every scrolling region (message list, sidebar)
    // to be the *inner* `flex-1 overflow-y-auto` panel.
    <div className="h-full flex bg-[hsl(232_60%_9%)] text-white relative overflow-hidden">
      {/* Mobile sidebar overlay */}
      <AnimatePresence>
        {mobileNavOpen && (
          <motion.div
            className="fixed inset-0 z-40 bg-black/60 md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setMobileNavOpen(false)}
          />
        )}
      </AnimatePresence>

      <div
        className={`md:flex ${mobileNavOpen ? "fixed z-50 inset-y-0 left-0 flex" : "hidden md:flex"}`}
      >
        <ProjectRail
          projects={projects}
          activeId={activeProjectId}
          onSelect={selectProject}
          sseStatus={sseStatus}
        />
        {activeProject && user && (
          <ChannelSidebar
            project={activeProject}
            channels={channels}
            projectMembers={[]}
            activeChannelId={activeDmId ? null : activeChannelId}
            onSelectChannel={selectChannel}
            me={user as ApiUser}
            myMicMuted={myMicMuted}
            myDeafened={myDeafened}
            onToggleMic={() => setMyMicMuted((v) => !v)}
            onToggleDeafen={() => setMyDeafened((v) => !v)}
            onCreateChannel={() => setCreateChannelOpen(true)}
            onOpenWorkObjects={() => setWorkObjectsListOpen(true)}
            onOpenMeetings={() => setMeetingsOpen(true)}
            allProjects={projects}
            orgMembers={members}
            activeDmId={activeDmId}
            onSelectDm={selectDm}
          />
        )}
        {user && (
          <WorkObjectsListDialog
            open={workObjectsListOpen}
            onClose={() => setWorkObjectsListOpen(false)}
            me={user as ApiUser}
            orgMembers={members}
            activeProjectId={activeProjectId}
          />
        )}
        {user && (
          <ScheduleCallDialog
            open={scheduleOpen}
            onClose={() => setScheduleOpen(false)}
            orgMembers={members}
            channels={channels}
            me={user as ApiUser}
            defaultChannelId={scheduleChannelId}
            defaultTitle={scheduleHint}
          />
        )}
        {user && (
          <MeetingsListDialog
            open={meetingsOpen}
            onClose={() => setMeetingsOpen(false)}
            orgMembers={members}
            me={user as ApiUser}
            onOpenScheduler={() => {
              setMeetingsOpen(false);
              setScheduleHint("");
              setScheduleChannelId(activeDmId ? null : activeChannelId);
              setScheduleOpen(true);
            }}
          />
        )}
        {activeProject && user && (
          <CreateChannelDialog
            open={createChannelOpen}
            onClose={() => setCreateChannelOpen(false)}
            projectId={activeProject.id}
            me={user as ApiUser}
            onCreated={(ch) => {
              // Auto-select the new channel for the creator.
              setChannelByProject((prev) => ({ ...prev, [activeProject.id]: ch.id }));
            }}
          />
        )}
      </div>

      {/* Main column */}
      {/* min-h-0 is critical: in a nested flex column, the default
          min-height: auto on flex children lets inner content (participant
          grid, screen-share preview, connection banners) push the entire
          column taller than the viewport. On iPhone PWAs that hides the
          shrink-0 bottom call-controls bar below the fold. */}
      <main className="flex-1 min-w-0 min-h-0 flex flex-col">
        {/* Mobile top bar */}
        <div className="md:hidden h-12 shrink-0 flex items-center justify-between px-3 bg-[hsl(232_55%_14%)] border-b border-black/40 sticky top-0 z-30">
          <button
            type="button"
            className="p-2 rounded hover-elevate"
            onClick={() => setMobileNavOpen((v) => !v)}
            data-testid="button-mobile-nav"
            aria-label="Toggle navigation"
          >
            {mobileNavOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          <div className="flex items-center gap-2">
            <VectorLogo size={22} className="text-white" monochrome />
            <span className="text-sm font-display tracking-wide">Bulldog Chat</span>
          </div>
          <div className="w-9" />
        </div>

        {/* Channel content */}
        {activeDmId ? (
          // DM view: same TextChannelView, hydrated from the DM channel row.
          // We deliberately do NOT pass workObjects/job props — DMs aren't
          // tied to jobs, so the right-rail Jobs panel toggle is hidden.
          dmChannelQ.isLoading || !dmChannelQ.data ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-vs-blue" />
            </div>
          ) : (
            <TextChannelView
              channel={dmChannelQ.data}
              messages={dmMessagesQ.data ?? []}
              loading={dmMessagesQ.isLoading}
              me={user as ApiUser}
              orgMembers={members}
              membersOpen={membersOpen}
              onToggleMembers={() => setMembersOpen((v) => !v)}
              workObjectsOpen={false}
              onToggleWorkObjects={() => {}}
              onSlashSchedule={(hint) => {
                setScheduleHint(hint);
                setScheduleChannelId(dmChannelQ.data?.id ?? null);
                setScheduleOpen(true);
              }}
            />
          )
        ) : channelsQ.isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-vs-blue" />
          </div>
        ) : channelsQ.data && channelsQ.data.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6 gap-2">
            <div className="text-sm text-white/70">No channels in this project yet.</div>
            <div className="text-xs text-white/40">Create a channel from the sidebar to get started.</div>
          </div>
        ) : !activeChannel ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-vs-blue" />
          </div>
        ) : (
          // Phase 1.9: unified channels. Every channel — text or legacy voice —
          // renders as TextChannelView, which already exposes Phone + Video
          // buttons in its header to start a LiveKit call inline. The
          // `channel.type` column is retained for back-compat (and for sidebar
          // sort/grouping) but no longer routes to a separate view.
          <TextChannelView
            channel={activeChannel}
            messages={messagesQ.data ?? []}
            loading={messagesQ.isLoading}
            me={user as ApiUser}
            orgMembers={members}
            membersOpen={membersOpen}
            onToggleMembers={() => setMembersOpen((v) => !v)}
            workObjectsOpen={workObjectsOpen}
            onToggleWorkObjects={() => setWorkObjectsOpen((v) => !v)}
            onSlashSchedule={(hint) => {
              setScheduleHint(hint);
              setScheduleChannelId(activeChannelId);
              setScheduleOpen(true);
            }}
          />
        )}
      </main>

      {/* Right rail (desktop ≥md): work objects panel (top) + members
          list (bottom). Both toggle independently from the channel header.
          When a DM is active, use the DM channel for member/job context;
          when a project channel is active, use that. */}
      {(() => {
        const viewChannel = activeDmId ? dmChannelQ.data : activeChannel;
        if (!viewChannel) return null;
        // DMs never have a Jobs panel — they're not tied to work objects.
        const showWorkObjects = !activeDmId && workObjectsOpen;
        if (!showWorkObjects && !membersOpen) return null;
        return (
          <div className="hidden md:flex md:flex-col">
            {showWorkObjects && (
              <WorkObjectPanel
                channelId={viewChannel.id}
                me={user as ApiUser}
                orgMembers={members}
                onClose={() => setWorkObjectsOpen(false)}
              />
            )}
            {membersOpen && (
              <MemberList
                members={members}
                meId={(user as ApiUser)?.id}
                orgMembers={members}
                channelId={viewChannel.id}
                channelName={viewChannel.name}
                myRole={(user as ApiUser)?.role}
              />
            )}
          </div>
        );
      })()}

      {/* Mobile (<md): MemberList renders as a slide-over drawer when
          the header Users icon is tapped. Backdrop dismisses. Add-member
          button is built into the drawer for admins. */}
      {(() => {
        const viewChannel = activeDmId ? dmChannelQ.data : activeChannel;
        if (!viewChannel || !membersOpen) return null;
        return (
          <div className="md:hidden">
            <MemberList
              members={members}
              meId={(user as ApiUser)?.id}
              orgMembers={members}
              channelId={viewChannel.id}
              channelName={viewChannel.name}
              myRole={(user as ApiUser)?.role}
              mobile
              onClose={() => setMembersOpen(false)}
            />
          </div>
        );
      })()}
    </div>
  );
}
