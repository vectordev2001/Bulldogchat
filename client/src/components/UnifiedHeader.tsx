import { useEffect, useState } from "react";
import { Menu, X, LogOut, User, Volume2, VolumeX, Home as HomeIcon, Hash, MessageSquare } from "lucide-react";
import { BulldogLogo } from "./BulldogLogo";
import { NotificationsButton } from "./NotificationsButton";
import { PatchNotesTrigger } from "./PatchNotesTrigger";
import { AppSwitcher } from "@/lib/AppSwitcher";
import { Avatar } from "./Avatar";
import { useAuth } from "@/lib/auth";
import { loadMeetPrefs, saveMeetPrefs, emitMeetPrefsChanged, MEET_PREFS_EVENT } from "@/lib/meet-prefs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * A resolved recent-channel row for the logo dropdown. The header stays
 * dumb about projects / DMs / cache lookups; the parent page hands over
 * ready-to-render rows (label, sub-label, onSelect) so this component
 * doesn't have to import query data.
 */
export interface RecentPick {
  key: string;
  label: string;
  subLabel?: string | null;
  kind: "channel" | "dm";
  onSelect: () => void;
}

interface Props {
  /** Sidebar/nav toggle state — controls the hamburger ↔ close icon. */
  navOpen: boolean;
  onToggleNav: () => void;
  /** Route to the app home/root when the logo dropdown "Home" item is picked. */
  onLogoClick: () => void;
  /**
   * Optional pre-resolved recent channels. When empty the logo dropdown
   * still shows the "Home" row so the click always does something —
   * previous behavior was a no-op button, which felt broken.
   */
  recentPicks?: RecentPick[];
}

/**
 * Unified Bulldog Suite top header. Identical layout across Chat / Contracts /
 * Ops; per-app identity comes only from <BulldogLogo>. Light theme only — no
 * theme toggle. Sign-out lives in the avatar dropdown, not as its own button.
 *
 *   [ ☰ ]  [ Logo + Wordmark ▾ ]  ……spacer……  [ 🔔 ]  [ ⋮⋮ ]  [ Avatar ]
 *
 * The logo pill is a DropdownMenu trigger: the top item is Home (which
 * previously fired on any logo click), followed by up to 5 recent
 * channels / DMs the user was working in. This turns the "logo does
 * nothing when I click it" surface into a fast jump list.
 */
export function UnifiedHeader({ navOpen, onToggleNav, onLogoClick, recentPicks }: Props) {
  const { user, logout } = useAuth();
  // Local mirror of the persisted `callSoundsEnabled` pref so the dropdown
  // item shows the current state without a route change. Subscribes to the
  // meet-prefs "changed" event so a toggle from anywhere (e.g. an in-call
  // settings modal, future) keeps this menu in sync.
  const [callSoundsOn, setCallSoundsOn] = useState<boolean>(() => loadMeetPrefs().callSoundsEnabled);
  useEffect(() => {
    const onChange = () => setCallSoundsOn(loadMeetPrefs().callSoundsEnabled);
    try { window.addEventListener(MEET_PREFS_EVENT, onChange); } catch { /* ignore */ }
    return () => {
      try { window.removeEventListener(MEET_PREFS_EVENT, onChange); } catch { /* ignore */ }
    };
  }, []);
  const toggleCallSounds = () => {
    const next = !callSoundsOn;
    setCallSoundsOn(next);
    saveMeetPrefs({ ...loadMeetPrefs(), callSoundsEnabled: next });
    // Broadcast so CallContext (which owns the ring loops) stops in-flight
    // sounds immediately, and any other subscribers re-read.
    emitMeetPrefsChanged();
  };

  // Cap at 5 recents. Anything beyond is silently dropped — the store
  // keeps 8 so we can still show 5 after any get filtered as deleted.
  const shownRecents = (recentPicks ?? []).slice(0, 5);

  return (
    <header
      className="shrink-0 sticky top-0 z-30 flex items-center h-14 md:h-16 px-4 md:px-6 bg-white border-b border-[hsl(215_20%_88%)]"
      data-testid="unified-header"
    >
      {/* Left cluster: menu toggle + logo/wordmark */}
      <button
        type="button"
        onClick={onToggleNav}
        className="h-10 w-10 -ml-2 mr-1 flex items-center justify-center rounded-md text-[hsl(var(--vs-text))] hover:bg-[hsl(var(--vs-navy-soft))] transition-colors"
        aria-label="Toggle navigation"
        data-testid="button-nav-toggle"
      >
        {navOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
      </button>

      {/* Logo dropdown trigger. Visually identical to the previous
          static pill (no chevron, no ring) so we don't shift the header
          layout — the affordance is discovered on hover / click.
          On mobile the pill still truncates the wordmark to "Chat". */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 rounded-md py-1 pr-2 hover:opacity-90 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--vs-accent))]"
            aria-label="Bulldog Chat home and recent channels"
            data-testid="button-logo-home"
          >
            <BulldogLogo app="chat" className="h-7 md:h-8 w-auto shrink-0" />
            <span className="min-w-0 truncate font-display font-semibold text-[16px] md:text-[18px] leading-none text-[hsl(var(--vs-accent))]">
              <span className="sm:hidden">Chat</span>
              <span className="hidden sm:inline">Bulldog Chat</span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-64 bg-popover border-popover-border text-popover-foreground"
        >
          <DropdownMenuItem
            onClick={() => onLogoClick()}
            className="text-sm cursor-pointer focus:bg-accent focus:text-accent-foreground"
            data-testid="menu-logo-home"
          >
            <HomeIcon className="w-3.5 h-3.5 mr-2 shrink-0 text-[hsl(var(--vs-text-subtle))]" />
            <span className="flex-1">Home</span>
          </DropdownMenuItem>
          {shownRecents.length > 0 && (
            <>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-[hsl(var(--vs-text-subtle))] font-medium">
                Recent
              </DropdownMenuLabel>
              {shownRecents.map((r) => (
                <DropdownMenuItem
                  key={r.key}
                  onClick={() => r.onSelect()}
                  className="text-sm cursor-pointer focus:bg-accent focus:text-accent-foreground"
                  data-testid={`menu-logo-recent-${r.kind}-${r.key}`}
                >
                  {r.kind === "dm"
                    ? <MessageSquare className="w-3.5 h-3.5 mr-2 shrink-0 text-[hsl(var(--vs-text-subtle))]" />
                    : <Hash className="w-3.5 h-3.5 mr-2 shrink-0 text-[hsl(var(--vs-text-subtle))]" />}
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-[hsl(var(--vs-text))]">{r.label}</div>
                    {r.subLabel && (
                      <div className="truncate text-[11px] text-[hsl(var(--vs-text-subtle))]">
                        {r.subLabel}
                      </div>
                    )}
                  </div>
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Flex spacer */}
      <div className="flex-1" />

      {/* Right cluster: notifications • app switcher • avatar */}
      <div className="flex shrink-0 items-center gap-1">
        <NotificationsButton variant="header" />
        <PatchNotesTrigger />
        <AppSwitcher currentApp="chat" placement="bottom-end" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="ml-1 rounded-full transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--vs-accent))]"
              aria-label="User menu"
              data-testid="button-user-menu"
            >
              <Avatar
                member={{
                  name: user?.name ?? "?",
                  hue: user?.hue ?? 220,
                  status: user?.status,
                }}
                size={32}
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-56 bg-popover border-popover-border text-popover-foreground"
          >
            <DropdownMenuLabel>
              <div className="font-semibold text-[hsl(var(--vs-text))] truncate">
                {user?.name}
              </div>
              {user?.email && (
                <div className="text-[11px] text-[hsl(var(--vs-text-subtle))] truncate font-normal">
                  {user.email}
                </div>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuItem
              className="text-sm cursor-pointer focus:bg-accent focus:text-accent-foreground"
              data-testid="menu-profile"
            >
              <User className="w-3.5 h-3.5 mr-2" /> Profile
            </DropdownMenuItem>
            {/* Call sounds toggle — flips the local `callSoundsEnabled`
                pref that gates the outgoing ringback + incoming chime in
                CallContext. Not a settings page, just a one-tap mute so
                users can silence rings when they're in another meeting.
                onSelect returns false-y so the menu stays open, letting
                the user see the icon change before dismissing. */}
            <DropdownMenuItem
              onSelect={(e) => { e.preventDefault(); toggleCallSounds(); }}
              className="text-sm cursor-pointer focus:bg-accent focus:text-accent-foreground"
              data-testid="menu-call-sounds"
              aria-checked={callSoundsOn}
            >
              {callSoundsOn
                ? <Volume2 className="w-3.5 h-3.5 mr-2" />
                : <VolumeX className="w-3.5 h-3.5 mr-2" />}
              <span className="flex-1">Call sounds</span>
              <span className="ml-2 text-[10px] font-mono uppercase tracking-wider text-[hsl(var(--vs-text-subtle))]">
                {callSoundsOn ? "On" : "Off"}
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuItem
              onClick={() => logout()}
              className="text-sm cursor-pointer focus:bg-accent focus:text-accent-foreground text-vs-danger"
              data-testid="menu-logout"
            >
              <LogOut className="w-3.5 h-3.5 mr-2" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
