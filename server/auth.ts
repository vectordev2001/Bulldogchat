import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import type { Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import type { User } from "@shared/schema";
import { type Role } from "@shared/permissions";

/**
 * Resolve a chat user's local role onto the Phase 2.0 Role enum. Chat stores
 * user/manager/admin now, but legacy rows may still read foreman/office/field/
 * safety/dispatcher/field_crew until the boot migration converges them — treat
 * any non-admin/non-manager value as "user".
 */
export function chatRole(u: { role: string }): Role {
  if (u.role === "admin" || u.role === "super_admin") return "admin";
  if (u.role === "manager") return "manager";
  return "user";
}

const JWT_SECRET = process.env.JWT_SECRET || "vector-chat-dev-secret-change-me";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

export const AUTH_COOKIE = "vc_token";

export interface AuthedRequest extends Request {
  user: User;
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  try { return bcrypt.compareSync(password, hash); } catch { return false; }
}

export function signJwt(userId: number): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS });
}

export function verifyJwt(token: string): number | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: number };
    return typeof payload.sub === "number" ? payload.sub : Number(payload.sub);
  } catch {
    return null;
  }
}

function extractToken(req: Request): string | null {
  // 1. Authorization header (Bearer)
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  // 2. Query token (for EventSource)
  if (typeof req.query.token === "string" && req.query.token) return req.query.token;
  // 3. Cookie (production fallback)
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ message: "Unauthorized" });
  const userId = verifyJwt(token);
  if (!userId) return res.status(401).json({ message: "Invalid token" });
  const user = storage.getUser(userId);
  if (!user) return res.status(401).json({ message: "User not found" });
  (req as AuthedRequest).user = user;
  storage.updateUserLastSeen(user.id);
  next();
}

export function tryAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (token) {
    const userId = verifyJwt(token);
    if (userId) {
      const user = storage.getUser(userId);
      if (user) (req as AuthedRequest).user = user;
    }
  }
  next();
}

export function requireRole(roles: User["role"][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const u = (req as AuthedRequest).user;
    if (!u) return res.status(401).json({ message: "Unauthorized" });
    if (!roles.includes(u.role)) return res.status(403).json({ message: "Forbidden" });
    next();
  };
}

/**
 * Phase 2.0 capability gate. Pass a predicate from the `can.chat.*` matrix;
 * it's evaluated against the caller's resolved Role. Replaces the old
 * hardcoded requireRole([...]) lists for chat actions.
 */
export function requireCap(capFn: (r: Role) => boolean) {
  return (req: Request, res: Response, next: NextFunction) => {
    const u = (req as AuthedRequest).user;
    if (!u) return res.status(401).json({ message: "Unauthorized" });
    if (!capFn(chatRole(u))) return res.status(403).json({ message: "Forbidden" });
    next();
  };
}

export function setAuthCookie(res: Response, token: string) {
  const isProd = process.env.NODE_ENV === "production";
  const parts = [
    `${AUTH_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${TOKEN_TTL_SECONDS}`,
  ];
  if (isProd) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearAuthCookie(res: Response) {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`);
}
