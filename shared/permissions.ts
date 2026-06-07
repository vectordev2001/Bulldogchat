/**
 * Phase 2.0 — unified permission helpers. Vendored copy shared across all 4
 * Bulldog apps (auth is the source of truth; keep this file in sync by hand).
 *
 * In chat the user's role lives on the local `users.role` column (synced from
 * auth). Chat collapses to user/manager/admin; super_admin from auth maps to
 * admin locally. These helpers take an already-resolved Role.
 */
export const ROLES = ["user", "manager", "admin", "super_admin"] as const;
export type Role = (typeof ROLES)[number];

export const can = {
  chat: {
    deleteOthersMessage: (r: Role) => r === "admin" || r === "super_admin",
    clearChannel: (r: Role) => r === "admin" || r === "super_admin",
    deleteMeetingNote: (r: Role) => r === "admin" || r === "super_admin",
    cancelOthersMeeting: (r: Role) => r !== "user",
    pinMessage: (r: Role) => r !== "user",
    createChannel: (r: Role) => r !== "user",
    deleteChannel: (r: Role) => r === "admin" || r === "super_admin",
    manageChannelMembers: (r: Role) => r !== "user",
    createProject: (r: Role) => r !== "user",
  },
  contracts: {
    sendForSignature: (r: Role) => r !== "user",
    sign: (r: Role) => r === "admin" || r === "super_admin",
    delete: (r: Role) => r === "admin" || r === "super_admin",
  },
  ops: {
    edit: (r: Role) => r !== "user",
    delete: (r: Role) => r === "admin" || r === "super_admin",
  },
};

export function isAdminish(r: Role): boolean {
  return r === "admin" || r === "super_admin";
}
