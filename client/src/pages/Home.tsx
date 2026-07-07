import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/lib/auth";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { hasDeepLink, parseDeepLink, stripDeepLinkFromUrl } from "@/lib/deep-link";
import { useSSE } from "@/hooks/use-sse";
import { useUnread } from "@/hooks/use-unread";
import { ProjectRail } from "@/components/ProjectRail";
import { ChannelSidebar } from "@/components/ChannelSidebar";
import { CreateChannelDialog } from "@/components/CreateChannelDialog";
import { TextChannelView } from "@/components/TextChannelView";
import { MemberList } from "@/components/MemberList";
import { WorkObjectPanel } from "@/components/WorkObjectPanel";
import { WorkObjectsListDialog } from "@/components/WorkObjectsListDialog";
import { ScheduleCallDialog, MeetingsListDialog } from "@/components/ScheduleCallDialog";
import { UnifiedHeader } from "@/components/UnifiedHeader";
import { VectorLogo } from "@/components/VectorLogo";
import { Pencil } from "lucide-react";
import { TitledChatDialog } from "@/components/TitledChatDialog";
import type { ApiProject, ApiChannel, ApiMessage, ApiUser, ApiDmChannel } from "@/types/api";

export default function Home() {
  const { user } = useAuth();

  // Project + channel selection
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [channelByProject, setChannelByProject] = useState<Record<number, number>>({});
  // Keyed by channelId — when set, TextChannelView renders a "Join call"
  // banner for that room name. Populated by the ?call=<room> deep-link
  // (from push notifications) and cleared when the user taps Join or
  // Dismiss on the banner.
  const [pendingCallByChannel, setPendingCallByChannel] = useState<Record<number, string>>({});
  // Keyed by channelId (or DM id — same numeric keyspace since DMs are channels
  // with scope='dm') — when set, TextChannelView scrolls the matching message
  // into view and briefly highlights it. Populated by the /m/<msgId> SMS deep
  // link and cleared by TextChannelView once it has done the scroll.
  const [pendingScrollByChannel, setPendingScrollByChannel] = useState<Record<number, number>>({});
  // Phase 1.9.1: Active DM selection. When non-null we render the DM thread
  // INSTEAD of the project channel — DMs are a parallel "view" that lives
  // above Jobs in the sidebar. Selecting a project channel clears the DM,
  // and selecting a DM doesn't disturb the per-project channel slot so the
  // user can hop back to where they were.
  const [activeDmId, setActiveDmId] = useState<number | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  // When the create-channel dialog is opened from a job row's context menu,
  // preselect that job so the new channel nests under it.
  const [createChannelDefaultJobId, setCreateChannelDefaultJobId] = useState<number | null>(null);
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

  // Per-company unread rollup for the star badge on the left sidebar rail.
  // The hook fetches `/api/me/unread` on mount + on any `unread:refresh`
  // window event (fired by SSE onMessageNew below and by missed-call flow
  // in CallContext). `markChannelRead` is fired when the user opens a
  // channel to persist a read receipt.
  const { byProjectId: unreadByProject, markChannelRead, markProjectRead } = useUnread({ enabled: !!user });
  const hasUnreadByProjectId = useMemo(() => {
    const map: Record<number, boolean> = {};
    for (const [pid, entry] of Object.entries(unreadByProject)) {
      if (entry?.hasUnread) map[Number(pid)] = true;
    }
    return map;
  }, [unreadByProject]);
  const unreadCountByProjectId = useMemo(() => {
    const map: Record<number, number> = {};
    for (const [pid, entry] of Object.entries(unreadByProject)) {
      // Combine chat + calls into a single numeric badge; the star already
      // carries the boolean signal, so this just gives the user a
      // magnitude hint.
      const total = (entry?.chat ?? 0) + (entry?.calls ?? 0);
      if (total > 0) map[Number(pid)] = total;
    }
    return map;
  }, [unreadByProject]);

  // Deep-link entrypoints:
  //   (a) legacy ?channel=<id>            — fired by contracts "Create chat meeting" button.
  //   (b) /#/channels/<id>?call=<room>    — fired by call push notifications.
  //
  // Both resolve to a target channel; (b) also stashes the ?call room name in
  // window-scoped state that TextChannelView reads to render a "Join call"
  // banner. Run once on mount and then strip the params so refreshes don't
  // re-apply the deep link. The hash-path form uses wouter's hash router
  // (window.location.hash) so parsing is manual (URL API doesn't split hashes).
  const [deepLinkPending, setDeepLinkPending] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return hasDeepLink(window.location.href);
  });
  useEffect(() => {
    if (!deepLinkPending) return;
    const parsed = parseDeepLink(window.location.href);
    if (!parsed || !Number.isFinite(parsed.channelId)) {
      setDeepLinkPending(false);
      return;
    }
    const { channelId, callRoom, messageId } = parsed;
    let cancelled = false;
    (async () => {
      try {
        // Fetch the channel row so we know (a) whether this is a DM (scope='dm')
        // vs a project channel, and (b) its projectId for the project-rail
        // selection. DMs don't have a projectId, so we route them into activeDmId
        // instead of channelByProject.
        const ch = await apiRequest<{
          id: number;
          projectId: number | null;
          scope?: string | null;
        }>("GET", `/api/channels/${channelId}`);
        if (cancelled || !ch) return;
        if (ch.scope === "dm") {
          // DM deep link — open the DM thread. This clears any per-project
          // channel selection because the DM view is exclusive.
          setActiveDmId(ch.id);
        } else if (ch.projectId) {
          setActiveProjectId(ch.projectId);
          setChannelByProject((prev) => ({ ...prev, [ch.projectId as number]: ch.id }));
        } else {
          return;
        }
        if (callRoom) {
          // Stash the pending call room name in a keyed store the channel
          // view reads to render its "Join call" banner. Keyed by channel
          // id so the banner only shows in the right channel.
          setPendingCallByChannel((prev) => ({ ...prev, [ch.id]: callRoom }));
        }
        if (messageId) {
          // Stash the target message id keyed by channel id. TextChannelView
          // reads this and scrolls the message into view (with a brief
          // highlight flash) once the message list has loaded. It's cleared
          // by the view after the scroll runs so a manual re-render doesn't
          // re-scroll.
          setPendingScrollByChannel((prev) => ({ ...prev, [ch.id]: messageId }));
        }
      } catch {
        /* fall through to default project */
      } finally {
        if (!cancelled) {
          stripDeepLinkFromUrl();
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

  // Titled Chats (Phase 2.5): the sidebar's DmSection already keeps
  // ["/api/dms"] warm (it polls + invalidates on SSE), so we just read the
  // same cache here to get memberIds + title for the header without a
  // second network round-trip. GET /api/channels/:id (used for dmChannelQ
  // above) doesn't decorate with memberIds, so this is the only place that
  // has what we need to derive "Alice, Bob" or show a custom title.
  const dmsQ = useQuery<ApiDmChannel[]>({
    queryKey: ["/api/dms"],
    enabled: !!user,
  });
  const activeDmRow = useMemo(
    () => dmsQ.data?.find((d) => d.id === activeDmId) ?? null,
    [dmsQ.data, activeDmId],
  );
  const [renameDmOpen, setRenameDmOpen] = useState(false);
  // Titled Chats (Phase 2.5): mirrors DmRow's label logic in DmSection.tsx
  // (title takes priority, else comma-joined other-participant names).
  const dmDisplayLabel = useMemo(() => {
    if (!activeDmId) return "";
    if (activeDmRow?.title) return activeDmRow.title;
    const meId = (user as ApiUser)?.id;
    const otherIds = (activeDmRow?.memberIds ?? []).filter((id) => id !== meId);
    if (otherIds.length === 0) return dmChannelQ.data?.name ?? "Direct message";
    const names = otherIds
      .map((id) => membersQ.data?.find((m) => m.id === id)?.name)
      .filter(Boolean) as string[];
    return names.length > 0 ? names.join(", ") : (dmChannelQ.data?.name ?? "Direct message");
  }, [activeDmId, activeDmRow, membersQ.data, user, dmChannelQ.data]);

  // SSE: invalidate messages on relevant events. New DM messages also kick
  // the DM list query so the sender re-sorts to the top of the section.
  const sseStatus = useSSE(!!user, {
    onMessageNew: (data) => {
      if (data?.channelId) {
        queryClient.invalidateQueries({ queryKey: ["/api/channels", data.channelId, "messages"] });
        // Cheap: always poke the DM list. The server returns 0 rows for
        // users who aren't in any DM channel, so the cost is negligible.
        queryClient.invalidateQueries({ queryKey: ["/api/dms"] });
        // Nudge the unread hook so the star-badge rail refreshes. Debounced
        // inside the hook so a burst of messages collapses to one HTTP
        // call.
        window.dispatchEvent(new CustomEvent("unread:refresh", { detail: { channelId: data.channelId } }));
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
    // Titled Chats (Phase 2.5): a DM's title changed, or a new titled DM
    // was created — either way, refresh the DM list so sidebars/header
    // pick up the new label. Also refresh the single-channel fetch behind
    // the active DM view in case the title change affects what's showing.
    onDmUpdated: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/dms"] });
      if (data?.channelId) {
        queryClient.invalidateQueries({ queryKey: ["/api/channels", data.channelId] });
      }
    },
    onDmCreated: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/dms"] });
    },
    // The SSE stream just reconnected after the WebView regained visibility.
    // Anything that changed while we were dark (e.g. an admin clearing this
    // channel) was missed, so refetch the messages for whatever view is open.
    onReopen: () => {
      const cid = activeDmId ?? activeChannelId;
      if (cid) {
        queryClient.invalidateQueries({ queryKey: ["/api/channels", cid, "messages"] });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/dms"] });
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
    // Persist a read receipt on channel open. Also clears the star badge
    // locally (optimistic) via the useUnread hook.
    markChannelRead(id);
  };
  const selectDm = (id: number) => {
    setActiveDmId(id);
    setMobileNavOpen(false);
    // DMs are channels with scope='dm', so the same read-receipt endpoint
    // clears their unread state. Without this, opening a DM would leave the
    // sidebar star lit forever for the parent company.
    markChannelRead(id);
  };

  // Phase 1.9: Escape-to-text behavior is no longer needed — every channel
  // is now a text channel that can optionally host a call. The Escape key
  // is handled by ChannelCallDialog when a call is active.

  // Loading state
  if (!user) return null;
  if (projectsQ.isLoading || membersQ.isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground gap-4">
        <VectorLogo size={56} className="text-vs-accent" monochrome />
        <Loader2 className="w-5 h-5 animate-spin text-vs-accent" />
        <p className="text-sm text-[hsl(var(--vs-text-muted))]">Loading Bulldog Chat…</p>
      </div>
    );
  }

  if (projectsQ.error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground gap-3 p-6 text-center">
        <VectorLogo size={48} className="text-vs-accent" monochrome />
        <h1 className="text-lg font-display">Could not load projects</h1>
        <p className="text-sm text-[hsl(var(--vs-text-muted))] max-w-md">{(projectsQ.error as Error).message}</p>
      </div>
    );
  }

  const projects = projectsQ.data ?? [];
  const channels = channelsQ.data ?? [];
  const members = membersQ.data ?? [];

  // Empty state — no projects
  if (projects.length === 0) {
    return (
      <div className="min-h-screen flex bg-background text-foreground">
        <ProjectRail
          projects={[]}
          activeId={null}
          onSelect={() => {}}
          sseStatus={sseStatus}
        />
        <main className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
          <VectorLogo size={64} className="text-vs-accent" monochrome />
          <h1 className="text-xl font-display">No projects yet</h1>
          <p className="text-sm text-[hsl(var(--vs-text-muted))] max-w-md">
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
    <div className="h-full flex bg-background text-foreground relative overflow-hidden">
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
          unreadByProjectId={unreadCountByProjectId}
          hasUnreadByProjectId={hasUnreadByProjectId}
          onMarkAllRead={markProjectRead}
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
            onCreateChannelInJob={(id) => { setCreateChannelDefaultJobId(id); setCreateChannelOpen(true); }}
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
            onClose={() => { setCreateChannelOpen(false); setCreateChannelDefaultJobId(null); }}
            projectId={activeProject.id}
            me={user as ApiUser}
            defaultWorkObjectId={createChannelDefaultJobId}
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
        {/* Unified Bulldog Suite top header — identical layout across
            Chat / Contracts / Ops. Per-app identity comes only from the
            BulldogLogo. Light theme; sign-out lives in the avatar menu. */}
        <UnifiedHeader
          navOpen={mobileNavOpen}
          onToggleNav={() => setMobileNavOpen((v) => !v)}
          onLogoClick={() => {
            const first = projectsQ.data?.[0];
            if (first) {
              setActiveProjectId(first.id);
              setActiveDmId(null);
            }
          }}
        />

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
            <div className="flex-1 min-h-0 flex flex-col relative">
              {/* Titled Chats (Phase 2.5): TextChannelView's header always
                  renders `channel.name` verbatim, which for a DM is the
                  internal `dm-<ids>-<ts>` identifier, not a display label.
                  We overlay the real title/participant-list here (matching
                  DmSection's row label logic) plus a pencil icon that opens
                  the same TitledChatDialog used for create/rename in the
                  sidebar. This sits directly on top of TextChannelView's
                  14px-tall header so no changes are needed there. */}
              <div className="absolute top-0 left-0 right-0 h-14 pl-14 md:pl-4 pr-4 flex items-center gap-1.5 pointer-events-none z-10">
                <span className="font-display text-[hsl(var(--vs-text))] text-base truncate max-w-[45vw] pointer-events-none">
                  {dmDisplayLabel}
                </span>
                <button
                  type="button"
                  onClick={() => setRenameDmOpen(true)}
                  className="p-1 rounded hover-elevate text-[hsl(var(--vs-text-muted))] hover:text-[hsl(var(--vs-accent))] pointer-events-auto"
                  title={activeDmRow?.title ? "Rename chat" : "Add a title"}
                  data-testid="button-rename-active-dm"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              </div>
              <TextChannelView
                // For DMs we render the label ourselves in the absolute
                // overlay above (with a pencil rename button). Setting
                // hideHeaderTitle prevents TextChannelView's own header
                // from stacking a second copy of the label on top of the
                // overlay (which caused a garbled "hastJustinBJieller"
                // effect). channel.name is still passed through so the
                // composer placeholder / welcome banner keep a sensible
                // label.
                channel={{ ...dmChannelQ.data, name: dmDisplayLabel }}
                hideHeaderTitle
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
                // SMS chat-mirror deep link: /#/dms/<id>/m/<msgId> stashes the
                // target message id in pendingScrollByChannel. Hand it to the
                // channel view so it can scroll + briefly highlight, then
                // clear it via onDidScrollToMessage.
                scrollToMessageId={
                  dmChannelQ.data?.id ? pendingScrollByChannel[dmChannelQ.data.id] ?? null : null
                }
                onDidScrollToMessage={() => {
                  const cid = dmChannelQ.data?.id;
                  if (!cid) return;
                  setPendingScrollByChannel((prev) => {
                    if (!(cid in prev)) return prev;
                    const next = { ...prev };
                    delete next[cid];
                    return next;
                  });
                }}
              />
              {renameDmOpen && activeDmId != null && (
                <TitledChatDialog
                  mode="rename"
                  dmId={activeDmId}
                  currentTitle={activeDmRow?.title ?? null}
                  onClose={() => setRenameDmOpen(false)}
                  onDone={() => setRenameDmOpen(false)}
                />
              )}
            </div>
          )
        ) : channelsQ.isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-vs-blue" />
          </div>
        ) : channelsQ.data && channelsQ.data.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6 gap-2">
            <div className="text-sm text-[hsl(var(--vs-text-muted))]">No channels in this project yet.</div>
            <div className="text-xs text-[hsl(var(--vs-text-subtle))]">Create a channel from the sidebar to get started.</div>
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
            // If a call push deep-linked us here with ?call=<room>, hand
            // the room name to the channel view so it can render the
            // one-tap "Join call" banner. The channel view calls
            // onDismissPendingCall() to clear it once the user acts.
            pendingCallRoom={activeChannelId ? pendingCallByChannel[activeChannelId] ?? null : null}
            onDismissPendingCall={() => {
              if (!activeChannelId) return;
              setPendingCallByChannel((prev) => {
                if (!(activeChannelId in prev)) return prev;
                const next = { ...prev };
                delete next[activeChannelId];
                return next;
              });
            }}
            // SMS chat-mirror deep link: /#/channels/<id>/m/<msgId> stashes
            // the target message id in pendingScrollByChannel. See the DM
            // branch above for the mirroring code path.
            scrollToMessageId={
              activeChannelId ? pendingScrollByChannel[activeChannelId] ?? null : null
            }
            onDidScrollToMessage={() => {
              if (!activeChannelId) return;
              setPendingScrollByChannel((prev) => {
                if (!(activeChannelId in prev)) return prev;
                const next = { ...prev };
                delete next[activeChannelId];
                return next;
              });
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
          <div className="hidden md:flex md:flex-col h-full min-h-0">
            {showWorkObjects && (
              <WorkObjectPanel
                channelId={viewChannel.id}
                me={user as ApiUser}
                orgMembers={members}
                onClose={() => setWorkObjectsOpen(false)}
                onSelectChannel={selectChannel}
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
