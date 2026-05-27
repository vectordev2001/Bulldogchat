import { Hash, Volume2, ChevronDown, Plus, Mic, MicOff, Headphones, Settings, Search, Shield } from "lucide-react";
import { useState, useMemo } from "react";
import { Avatar } from "./Avatar";
import type { ApiChannel, ApiProject, ApiUser } from "@/types/api";

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
}

export function ChannelSidebar({
  project, channels, projectMembers, activeChannelId, onSelectChannel,
  me, myMicMuted, myDeafened, onToggleMic, onToggleDeafen,
}: Props) {
  const { text, voice } = useMemo(() => {
    const t = channels.filter(c => c.type === "text").sort((a, b) => a.position - b.position);
    const v = channels.filter(c => c.type === "voice").sort((a, b) => a.position - b.position);
    return { text: t, voice: v };
  }, [channels]);

  const [textOpen, setTextOpen] = useState(true);
  const [voiceOpen, setVoiceOpen] = useState(true);
  const [search, setSearch] = useState("");

  const filteredText = text.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  const filteredVoice = voice.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <aside
      className="flex flex-col w-[240px] shrink-0 vs-navy border-r border-black/40"
      data-testid="sidebar-channels"
    >
      <div className="h-14 px-4 flex items-center justify-between border-b border-black/30 shadow-sm">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.14em] text-vs-red font-bold">Project</div>
          <div className="text-sm font-display text-white truncate" title={project.name}>
            {project.name}
          </div>
        </div>
        <button
          type="button"
          className="text-[hsl(0_0%_65%)] hover:text-white transition-colors p-1"
          title="Project info"
          data-testid="button-project-settings"
        >
          <ChevronDown className="w-4 h-4" />
        </button>
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
        <Section label="Text Channels" open={textOpen} onToggle={() => setTextOpen(!textOpen)}>
          {textOpen && filteredText.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              active={c.id === activeChannelId}
              onClick={() => onSelectChannel(c.id)}
            />
          ))}
          {textOpen && filteredText.length === 0 && (
            <div className="px-2 py-1.5 text-[11px] text-[hsl(0_0%_55%)]">No matching channels.</div>
          )}
        </Section>

        <Section label="Voice Channels" open={voiceOpen} onToggle={() => setVoiceOpen(!voiceOpen)}>
          {voiceOpen && filteredVoice.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              active={c.id === activeChannelId}
              onClick={() => onSelectChannel(c.id)}
            />
          ))}
        </Section>
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
          <IconBtn title="User Settings" testid="button-user-settings">
            <Settings className="w-4 h-4" />
          </IconBtn>
        </div>
      </div>
    </aside>
  );
}

function Section({
  label, open, onToggle, children,
}: { label: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="group w-full flex items-center justify-between px-1.5 py-1 text-[10px] uppercase tracking-[0.16em] font-bold text-[hsl(0_0%_55%)] hover:text-white transition-colors"
      >
        <span className="flex items-center gap-1">
          <ChevronDown className={`w-3 h-3 transition-transform ${open ? "" : "-rotate-90"}`} />
          {label}
        </span>
        <Plus className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity" />
      </button>
      <div className="mt-1 space-y-0.5">{children}</div>
    </div>
  );
}

function ChannelRow({
  channel, active, onClick,
}: { channel: ApiChannel; active: boolean; onClick: () => void }) {
  const Icon = channel.type === "voice" ? Volume2 : Hash;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`channel-${channel.id}`}
      className={[
        "relative w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors group",
        active ? "bg-[hsl(232_45%_30%)] text-white" : "text-[hsl(0_0%_75%)] hover:bg-[hsl(232_45%_25%)] hover:text-white",
      ].join(" ")}
    >
      {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-vs-red" />}
      <Icon className={`w-4 h-4 shrink-0 ${active ? "text-vs-red" : "text-[hsl(0_0%_50%)]"}`} />
      <span className="truncate font-medium">{channel.name}</span>
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
