/**
 * <AppSwitcher /> — drop-in navigation across the Bulldog Suite apps.
 *
 * Usage:
 *
 *   import { AppSwitcher } from "@bulldog/auth-client/react";
 *   <AppSwitcher currentApp="chat" />
 *
 * Renders a small icon button. Clicking it opens a popover with the 3 suite
 * apps and an Account link. Highlights the current app.
 *
 * Peer deps: react >= 18
 */
import React, { useEffect, useRef, useState } from "react";

export interface AppSwitcherProps {
  currentApp: "chat" | "contracts" | "ops" | "auth" | "home";
  /** Override the link targets if your URLs differ. */
  links?: Partial<Record<"chat" | "contracts" | "ops" | "auth" | "home", string>>;
  /** Optional CSS class for the trigger button. */
  className?: string;
  /** Render compact dark variant (for dark headers). */
  dark?: boolean;
}

const DEFAULT_LINKS: Record<"chat" | "contracts" | "ops" | "auth" | "home", string> = {
  home: "https://bulldogops.com",
  chat: "https://chat.bulldogops.com",
  contracts: "https://vectorcontracts.bulldogops.com",
  ops: "https://ops.bulldogops.com",
  auth: "https://auth.bulldogops.com",
};

interface AppEntry {
  key: "chat" | "contracts" | "ops";
  label: string;
  sub: string;
  accent: string;
  icon: JSX.Element;
}

const ENTRIES: AppEntry[] = [
  {
    key: "chat",
    label: "Chat",
    sub: "Team messaging",
    accent: "bg-gradient-to-br from-orange-500 to-amber-500",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    ),
  },
  {
    key: "contracts",
    label: "Contracts",
    sub: "Document mgmt",
    accent: "bg-gradient-to-br from-sky-600 to-indigo-500",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    ),
  },
  {
    key: "ops",
    label: "Ops",
    sub: "Field operations",
    accent: "bg-gradient-to-br from-emerald-600 to-teal-500",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
    ),
  },
];

export function AppSwitcher({ currentApp, links, className, dark }: AppSwitcherProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, []);

  const resolved = { ...DEFAULT_LINKS, ...(links || {}) };
  const triggerClass = dark
    ? "p-2 rounded-md text-slate-300 hover:bg-white/10 hover:text-white"
    : "p-2 rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900";

  return (
    <div className={`relative inline-block ${className || ""}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Switch app"
        title="Switch app"
        className={triggerClass}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
          <circle cx="5" cy="5" r="1.6" />
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="19" cy="5" r="1.6" />
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
          <circle cx="5" cy="19" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
          <circle cx="19" cy="19" r="1.6" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-72 rounded-xl bg-white shadow-xl border border-slate-200 p-2 z-50">
          <div className="px-3 pt-2 pb-1 flex items-center justify-between">
            <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">Bulldog Suite</div>
            <a
              href={resolved.home}
              className="text-[11px] text-slate-500 hover:text-slate-900"
              onClick={() => setOpen(false)}
            >
              Home ↗
            </a>
          </div>
          <div className="grid grid-cols-3 gap-1 p-1">
            {ENTRIES.map((app) => {
              const isCurrent = app.key === currentApp;
              return (
                <a
                  key={app.key}
                  href={resolved[app.key]}
                  className={`flex flex-col items-center text-center px-2 py-3 rounded-lg transition ${
                    isCurrent ? "bg-slate-50 ring-1 ring-slate-200" : "hover:bg-slate-50"
                  }`}
                  onClick={() => setOpen(false)}
                  aria-current={isCurrent ? "page" : undefined}
                >
                  <div className={`${app.accent} text-white h-9 w-9 rounded-lg grid place-items-center mb-1.5 shadow-sm`}>
                    {app.icon}
                  </div>
                  <div className="text-xs font-medium text-slate-900">{app.label}</div>
                  <div className="text-[10px] text-slate-500">{app.sub}</div>
                </a>
              );
            })}
          </div>
          <div className="border-t border-slate-100 mt-1 pt-1">
            <a
              href={resolved.auth}
              className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-slate-700 hover:bg-slate-50"
              onClick={() => setOpen(false)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              Account & users
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
