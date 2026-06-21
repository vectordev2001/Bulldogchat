import { Menu, X, LogOut, User } from "lucide-react";
import { BulldogLogo } from "./BulldogLogo";
import { NotificationsButton } from "./NotificationsButton";
import { AppSwitcher } from "@/lib/AppSwitcher";
import { Avatar } from "./Avatar";
import { useAuth } from "@/lib/auth";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Props {
  /** Sidebar/nav toggle state — controls the hamburger ↔ close icon. */
  navOpen: boolean;
  onToggleNav: () => void;
  /** Route to the app home/root when the logo is clicked. */
  onLogoClick: () => void;
}

/**
 * Unified Bulldog Suite top header. Identical layout across Chat / Contracts /
 * Ops; per-app identity comes only from <BulldogLogo>. Light theme only — no
 * theme toggle. Sign-out lives in the avatar dropdown, not as its own button.
 *
 *   [ ☰ ]  [ Logo + Wordmark ]  ……spacer……  [ 🔔 ]  [ ⋮⋮ ]  [ Avatar ]
 */
export function UnifiedHeader({ navOpen, onToggleNav, onLogoClick }: Props) {
  const { user, logout } = useAuth();

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

      <button
        type="button"
        onClick={onLogoClick}
        className="flex min-w-0 items-center gap-2 rounded-md py-1 pr-2 hover:opacity-90 transition-opacity"
        aria-label="Bulldog Chat home"
        data-testid="button-logo-home"
      >
        <BulldogLogo app="chat" className="h-7 md:h-8 w-auto shrink-0" />
        <span className="min-w-0 truncate font-display font-semibold text-[16px] md:text-[18px] leading-none text-[hsl(var(--vs-accent))]">
          <span className="sm:hidden">Chat</span>
          <span className="hidden sm:inline">Bulldog Chat</span>
        </span>
      </button>

      {/* Flex spacer */}
      <div className="flex-1" />

      {/* Right cluster: notifications • app switcher • avatar */}
      <div className="flex shrink-0 items-center gap-1">
        <NotificationsButton variant="header" />
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
