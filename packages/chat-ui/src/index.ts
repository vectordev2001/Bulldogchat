// @vectordev2001/chat-ui — shared chat UI package.
//
// Primary entrypoint: the `ChatApp` component (the full sidebar + channel +
// right-panel experience, extracted from client/src/pages/Home.tsx) plus the
// auth context/types + queryClient helpers that ChatApp and its child
// components depend on.
//
// Individual components/hooks/lib modules are also importable directly via
// deep paths, e.g. `@vectordev2001/chat-ui/components/TextChannelView` or
// `@vectordev2001/chat-ui/lib/utils` — see package.json's `exports` map.
// That's the primary way client/src's re-export shims and the widget consume
// this package; this barrel is a convenience for the most common imports.

export { ChatApp } from "./components/ChatApp";
export type { ChatAppProps } from "./components/ChatApp";

export { AuthContext, useAuth } from "./lib/auth-context";
export type { AuthState, PublicUser, Org } from "./lib/auth-context";

export {
  queryClient,
  apiRequest,
  apiUpload,
  getQueryFn,
  setApiBase,
  getApiBase,
  setAuthToken,
  getAuthToken,
  authHeaders,
  apiCreateTitledDm,
  apiRenameDm,
} from "./lib/queryClient";

export type {
  ApiProject,
  ApiChannel,
  ApiMessage,
  ApiUser,
  ApiDmChannel,
} from "./types/api";
