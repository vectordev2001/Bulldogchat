import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Menu, X, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/lib/auth";
import { queryClient } from "@/lib/queryClient";
import { useSSE } from "@/hooks/use-sse";
import { ProjectRail } from "@/components/ProjectRail";
import { ChannelSidebar } from "@/components/ChannelSidebar";
import { TextChannelView } from "@/components/TextChannelView";
import { VoiceChannelView } from "@/components/VoiceChannelView";
import { MemberList } from "@/components/MemberList";
import { VectorLogo } from "@/components/VectorLogo";
import type { ApiProject, ApiChannel, ApiMessage, ApiUser } from "@/types/api";

export default function Home() {
  const { user } = useAuth();

  // Project + channel selection
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [channelByProject, setChannelByProject] = useState<Record<number, number>>({});
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Self-call state
  const [myMicMuted, setMyMicMuted] = useState(false);
  const [myDeafened, setMyDeafened] = useState(false);
  const [myVideoOn, setMyVideoOn] = useState(false);
  const [myScreenSharing, setMyScreenSharing] = useState(false);
  const [myHandRaised, setMyHandRaised] = useState(false);

  // --- Queries ---
  const projectsQ = useQuery<ApiProject[]>({
    queryKey: ["/api/projects"],
    enabled: !!user,
  });

  const membersQ = useQuery<ApiUser[]>({
    queryKey: ["/api/org/members"],
    enabled: !!user,
  });

  // Pick a default project once data is loaded
  useEffect(() => {
    if (!activeProjectId && projectsQ.data && projectsQ.data.length > 0) {
      setActiveProjectId(projectsQ.data[0].id);
    }
  }, [projectsQ.data, activeProjectId]);

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

  // Escape from voice channel back to first text
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && activeChannel?.type === "voice" && channelsQ.data) {
        const firstText = [...channelsQ.data].sort((a, b) => a.position - b.position).find((c) => c.type === "text");
        if (firstText) selectChannel(firstText.id);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannel?.type, channelsQ.data, activeProjectId]);

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
    <div className="min-h-screen flex bg-[hsl(232_60%_9%)] text-white relative">
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
          />
        )}
      </div>

      {/* Main column */}
      <main className="flex-1 min-w-0 flex flex-col">
        {/* Mobile top bar */}
        <div className="md:hidden h-12 flex items-center justify-between px-3 bg-[hsl(232_55%_14%)] border-b border-black/40">
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
        ) : activeChannel.type === "voice" ? (
          <VoiceChannelView
            channel={activeChannel}
            me={user as ApiUser}
            orgMembers={members}
            myMicMuted={myMicMuted}
            myVideoOn={myVideoOn}
            myScreenSharing={myScreenSharing}
            myHandRaised={myHandRaised}
            onToggleMic={() => setMyMicMuted((v) => !v)}
            onToggleVideo={() => setMyVideoOn((v) => !v)}
            onToggleScreen={() => setMyScreenSharing((v) => !v)}
            onToggleHand={() => setMyHandRaised((v) => !v)}
            onLeave={() => {
              const firstText = [...channels]
                .sort((a, b) => a.position - b.position)
                .find((c) => c.type === "text");
              if (firstText) selectChannel(firstText.id);
            }}
          />
        ) : (
          <TextChannelView
            channel={activeChannel}
            messages={messagesQ.data ?? []}
            loading={messagesQ.isLoading}
            me={user as ApiUser}
            orgMembers={members}
          />
        )}
      </main>

      {/* Right rail: members (desktop only, on text channels) */}
      {activeChannel?.type === "text" && (
        <div className="hidden xl:flex">
          <MemberList members={members} meId={(user as ApiUser)?.id} />
        </div>
      )}
    </div>
  );
}
