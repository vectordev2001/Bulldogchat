import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import Login from "@/pages/Login";
import Signup from "@/pages/Signup";
import AcceptInvite from "@/pages/AcceptInvite";
import AdminPanel from "@/pages/AdminPanel";
import CallJoin from "@/pages/CallJoin";
import MeetingJoin from "@/pages/meetings/Join";
import MeetingRoom from "@/pages/meetings/Room";
import MeetingEnd from "@/pages/meetings/End";
import { MeetingProvider } from "@/lib/meeting";
import { AuthProvider, useAuth } from "@/lib/auth";
import { PresenceProvider } from "@/hooks/use-presence";
import { CallProvider } from "@/lib/CallContext";
import { CallOverlays } from "@/components/CallOverlays";
import { IosInstallBanner } from "@/components/IosInstallBanner";
import BogeyBubble from "@/components/BogeyBubble";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { VectorLogo } from "@/components/VectorLogo";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (loading || user) return;
    // Bulldog Suite SSO: bounce to auth.bulldogops.com which sets the
    // cross-subdomain bulldog_access cookie and returns via ?next=.
    // ?local=1 keeps the legacy local /login page for emergencies.
    const search = new URLSearchParams(window.location.search);
    const wantsLocal = search.get("local") === "1";
    const isLocalDev =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    if (wantsLocal || isLocalDev) {
      setLocation("/login");
      return;
    }
    const here = window.location.href;
    window.location.replace(
      `https://auth.bulldogops.com/?next=${encodeURIComponent(here)}`,
    );
  }, [loading, user, setLocation]);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[hsl(220_60%_9%)] text-white gap-4">
        <VectorLogo size={56} className="text-vs-blue" monochrome />
        <Loader2 className="w-5 h-5 animate-spin text-vs-blue" />
      </div>
    );
  }
  if (!user) return null;
  return <>{children}</>;
}

// Public meeting routes intentionally bypass ProtectedRoute/SSO so external
// guests can join via a shared /m/:code link.
function AppRouter() {
  return (
    <Switch>
      <Route path="/m/:code" component={MeetingJoin} />
      <Route path="/r/:code" component={MeetingRoom} />
      <Route path="/end/:code" component={MeetingEnd} />

      <Route path="/login" component={Login} />
      <Route path="/signup" component={Signup} />
      <Route path="/accept-invite/:token" component={AcceptInvite} />
      <Route path="/admin">{() => <ProtectedRoute><AdminPanel /></ProtectedRoute>}</Route>
      <Route path="/call-join/:token">{() => <ProtectedRoute><CallJoin /></ProtectedRoute>}</Route>
      {/* Deep-link catch-alls: /#/dms/<id>/m/<msgId> and /#/channels/<id>[/m/<msgId>]
          are emitted by SMS chat-mirror and push notifications. Home.tsx reads
          window.location.href directly via parseDeepLink so it handles all forms. */}
      <Route path="/dms/:rest*">{() => <ProtectedRoute><Home /></ProtectedRoute>}</Route>
      <Route path="/channels/:rest*">{() => <ProtectedRoute><Home /></ProtectedRoute>}</Route>
      <Route path="/">{() => <ProtectedRoute><Home /></ProtectedRoute>}</Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <PresenceProvider>
        <CallProvider>
          <TooltipProvider>
            <Toaster />
            <IosInstallBanner appName="Bulldog Chat" />
            {/* MeetingProvider wraps the Router so its state (token, wsUrl,
                prejoin device prefs, prejoinTracksRef) survives the /m → /r
                navigation. If the provider lived under a per-route wrapper,
                wouter's <Switch> would unmount it on each path change and the
                Room route would see token=null, bouncing the user back to the
                prejoin screen — the classic "have to click Join twice" bug. */}
            <MeetingProvider>
              <Router hook={useHashLocation}>
                <AppRouter />
                {/* Bogey — Bulldog Suite AI. Renders as a floating bubble on
                    every eligible page. The component gates its own
                    visibility (managers + admins only) and hides itself on
                    auth screens and inside active meetings. */}
                <BogeyBubble />
              </Router>
            </MeetingProvider>
            <CallOverlays />
          </TooltipProvider>
        </CallProvider>
        </PresenceProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
