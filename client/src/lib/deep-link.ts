// Re-export shim — moved to packages/chat-ui/src/lib/deep-link.ts as part of
// the widget-parity refactor (ChatApp, which contains this logic, now lives
// in chat-ui). Kept here so "@/lib/deep-link" imports in client/src continue
// to resolve unchanged.
export * from "@vectordev2001/chat-ui/lib/deep-link";
