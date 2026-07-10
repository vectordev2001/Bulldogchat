import { useAuth } from "@/lib/auth";
import { ChatApp } from "@vectordev2001/chat-ui/components/ChatApp";
import type { ApiUser } from "@/types/api";

// The full sidebar + channel + right-panel experience now lives in
// packages/chat-ui/src/components/ChatApp.tsx so the widget can mount the
// exact same UI (see widget/src/BulldogChatWidget.tsx). Home.tsx is just the
// main-app wiring: pull `user` from the app's real AuthProvider/useAuth and
// hand it to ChatApp. No apiBaseUrl is passed — same-origin, matching the
// app's existing behavior exactly.
export default function Home() {
  const { user } = useAuth();
  // useAuth()'s PublicUser and ChatApp's ApiUser are structurally
  // compatible (id/name/email/role/...) — this mirrors the existing
  // `user as ApiUser` casts that were already sprinkled through the old
  // Home.tsx render body.
  return <ChatApp user={user as unknown as ApiUser | null} />;
}
