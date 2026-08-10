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
  scorecard: {
    // Phase 2.6 — recruiter scorecard channel. Reads are open to any project
    // member (RBAC enforced via channel visibility).
    //
    // Two capabilities:
    //   editConfig — admin/super_admin only. Gates the program config (fee
    //     target, profit floor, stretch tier, recruiter list including
    //     salaries) and the ability to *see* per-recruiter salaries at all.
    //   editPlacements — managers + admins. Gates logging, editing, and
    //     deleting individual placement rows plus rolling up monthly
    //     actuals. Managers can maintain their own team's data without
    //     seeing salaries or being able to reshape the program.
    //
    // `edit` is retained as an alias of `editConfig` for backward compat
    // with older callers; new code should use the split names.
    editConfig: (r: Role) => r === "admin" || r === "super_admin",
    editPlacements: (r: Role) => r !== "user",
    edit: (r: Role) => r === "admin" || r === "super_admin",
  },
};

export function isAdminish(r: Role): boolean {
  return r === "admin" || r === "super_admin";
}
