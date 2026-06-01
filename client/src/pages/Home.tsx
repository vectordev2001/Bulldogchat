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
import { VectorLogo } from "@/components/VectorLogo";
import type { ApiProject, ApiChannel, ApiMessage, ApiUser } from "@/types/api";

export default function Home() {
  const { user } = useAuth();

  // Project + channel selection
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [channelByProject, setChannelByProject] = useState<Record<number, number>>({});
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  // Right-rail members list. On large screens (xl+) it's shown by default;
  // the header Users icon lets the user collapse/expand it explicitly so
  // mid-size screens can also see the roster on demand.
  const [membersOpen, setMembersOpen] = useState(true);
  // Right-rail work objects panel — opt-in; toggled from channel header.
  const [workObjectsOpen, setWorkObjectsOpen] = useState(false);
  // Org-wide Work Objects list modal — launched from sidebar.
  const [workObjectsListOpen, setWorkObjectsListOpen] = useState(false);

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

  // Default-select first text channel for the active project
  useEffect(() => {
    if (!activeProjectId || !channelsQ.data) return;
    if (channelByProject[activeProjectId]) return;
    const sorted = [...channelsQ.data].sort((a, b) => a.position - b.position);
    const firstText = sorted.find((c) => c.type === "text") ?? sorted[0];
    if (firstText) {
      setChannelByProject((prev) => ({ ...prev, [activeProjectId]: firstText.id }));
    }
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
    enabled: !!activeChannelId && activeChannel?.type === "text",
  });

  // SSE: invalidate messages on relevant events
  const sseStatus = useSSE(!!user, {
    onMessageNew: (data) => {
      if (data?.channelId) {
        queryClient.invalidateQueries({ queryKey: ["/api/channels", data.channelId, "messages"] });
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
  });

  const selectProject = (id: number) => {
    setActiveProjectId(id);
    setMobileNavOpen(false);
  };
  const selectChannel = (id: number) => {
    if (activeProjectId == null) return;
    setChannelByProject((prev) => ({ ...prev, [activeProjectId]: id }));
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
            activeChannelId={activeChannelId}
            onSelectChannel={selectChannel}
            me={user as ApiUser}
            myMicMuted={myMicMuted}
            myDeafened={myDeafened}
            onToggleMic={() => setMyMicMuted((v) => !v)}
            onToggleDeafen={() => setMyDeafened((v) => !v)}
            onCreateChannel={() => setCreateChannelOpen(true)}
            onOpenWorkObjects={() => setWorkObjectsListOpen(true)}
            allProjects={projects}
            orgMembers={members}
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
        {!activeChannel || channelsQ.isLoading ? (
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
          />
        )}
      </main>

      {/* Right rail: work objects panel (top) + members list (bottom).
          Both toggle independently from the channel header. */}
      {activeChannel && (workObjectsOpen || membersOpen) && (
        <div className="hidden md:flex md:flex-col">
          {workObjectsOpen && (
            <WorkObjectPanel
              channelId={activeChannel.id}
              me={user as ApiUser}
              orgMembers={members}
              onClose={() => setWorkObjectsOpen(false)}
            />
          )}
          {membersOpen && (
            <MemberList members={members} meId={(user as ApiUser)?.id} />
          )}
        </div>
      )}
    </div>
  );
}
