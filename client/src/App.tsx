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
import { AuthProvider, useAuth } from "@/lib/auth";
import { CallProvider } from "@/lib/CallContext";
import { CallOverlays } from "@/components/CallOverlays";
import { IosInstallBanner } from "@/components/IosInstallBanner";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { VectorLogo } from "@/components/VectorLogo";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!loading && !user) setLocation("/login");
  }, [loading, user, setLocation]);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[hsl(232_60%_9%)] text-white gap-4">
        <VectorLogo size={56} className="text-vs-blue" monochrome />
        <Loader2 className="w-5 h-5 animate-spin text-vs-blue" />
      </div>
    );
  }
  if (!user) return null;
  return <>{children}</>;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/signup" component={Signup} />
      <Route path="/accept-invite/:token" component={AcceptInvite} />
      <Route path="/admin">{() => <ProtectedRoute><AdminPanel /></ProtectedRoute>}</Route>
      <Route path="/">{() => <ProtectedRoute><Home /></ProtectedRoute>}</Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <CallProvider>
          <TooltipProvider>
            <Toaster />
            <div className="min-h-[100dvh] flex flex-col">
              <IosInstallBanner appName="Bulldog Chat" />
              <div className="flex-1 min-h-0 flex flex-col">
                <Router hook={useHashLocation}>
                  <AppRouter />
                </Router>
              </div>
            </div>
            <CallOverlays />
          </TooltipProvider>
        </CallProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
