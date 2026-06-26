import type { Request, Response, NextFunction, RequestHandler } from "express";
import { importSPKI, jwtVerify, type JWTPayload, type KeyLike } from "jose";

/**
 * @bulldog/auth-client
 *
 * Drop-in middleware for any Bulldog Suite app (chat, contracts, ops).
 * - Reads the access JWT from the `bulldog_access` cookie or `Authorization: Bearer` header
 * - Verifies signature using the bulldog-auth public key (fetched once and cached)
 * - Attaches `req.user` with { id, email, name, role, department }
 *
 * Usage:
 *
 *   import { bulldogAuth } from "@bulldog/auth-client";
 *
 *   app.use("/api", bulldogAuth({
 *     authBaseUrl: "https://auth.bulldogops.com",
 *     // Optional: restrict by role
 *     // allowedRoles: ["admin", "office"],
 *   }));
 *
 *   app.get("/api/me", (req, res) => res.json(req.user));
 */

export interface BulldogUser {
  id: string;
  email: string;
  name: string;
  role: string;
  department: string | null;
  /** E.164 phone number, optional — used for SIP dial-out invites. */
  phone?: string | null;
  /** Phase 2.0 unified global role. May be "super_admin" which collapses to admin in `role`. */
  globalRole?: "user" | "manager" | "admin" | "super_admin";
  /** Phase 2.0 access grants. Empty/missing → no Suite access. */
  grants?: Array<{ companyId: string; locationId: string | null }>;
  /** Phase 2.0 per-company role overrides. */
  roleOverrides?: Array<{ companyId: string; role: "user" | "manager" | "admin" }>;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: BulldogUser;
  }
}

export interface AuthOptions {
  /** Base URL of the bulldog-auth service. e.g. https://auth.bulldogops.com */
  authBaseUrl: string;
  /** Name of the access cookie. Defaults to "bulldog_access" */
  accessCookieName?: string;
  /** Restrict access to one or more roles. */
  allowedRoles?: string[];
  /** If true, populate req.user when present but don't 401 on missing/invalid. */
  optional?: boolean;
  /** Override the public key URL. Default `${authBaseUrl}/.well-known/auth-public-key.pem` */
  publicKeyUrl?: string;
  /** How often to refetch the public key (ms). Default 1 hour. */
  refreshIntervalMs?: number;
}

const ISSUER = "bulldog-auth";

let cachedKey: KeyLike | undefined;
let cachedAt = 0;

async function loadPublicKey(opts: AuthOptions): Promise<KeyLike> {
  const refreshMs = opts.refreshIntervalMs ?? 60 * 60 * 1000;
  if (cachedKey && Date.now() - cachedAt < refreshMs) return cachedKey;
  const url = opts.publicKeyUrl || `${opts.authBaseUrl.replace(/\/$/, "")}/.well-known/auth-public-key.pem`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bulldog-auth: failed to fetch public key (${res.status})`);
  const pem = await res.text();
  cachedKey = await importSPKI(pem, "RS256");
  cachedAt = Date.now();
  return cachedKey;
}

function readTokenFromRequest(req: Request, cookieName: string): string | undefined {
  // Authorization header
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  // Cookie — supports both express + cookie-parser style and raw header
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = (req as any).cookies as Record<string, string> | undefined;
  if (parsed && parsed[cookieName]) return parsed[cookieName];
  const raw = req.headers.cookie;
  if (raw) {
    const m = raw.split(/;\s*/).find((p) => p.startsWith(`${cookieName}=`));
    if (m) return decodeURIComponent(m.slice(cookieName.length + 1));
  }
  return undefined;
}

export function bulldogAuth(options: AuthOptions): RequestHandler {
  const cookieName = options.accessCookieName || "bulldog_access";
  const roles = options.allowedRoles && new Set(options.allowedRoles);

  return async function handler(req: Request, res: Response, next: NextFunction) {
    const token = readTokenFromRequest(req, cookieName);
    if (!token) {
      if (options.optional) return next();
      return res.status(401).json({ message: "Not signed in" });
    }
    try {
      const key = await loadPublicKey(options);
      const { payload } = await jwtVerify(token, key, { issuer: ISSUER });
      const claims = payload as JWTPayload & {
        sub?: string;
        email?: string;
        name?: string;
        role?: string;
        department?: string | null;
        phone?: string | null;
        globalRole?: "user" | "manager" | "admin" | "super_admin";
        grants?: Array<{ companyId: string; locationId: string | null }>;
        roleOverrides?: Array<{ companyId: string; role: "user" | "manager" | "admin" }>;
      };
      if (!claims.sub || !claims.email || !claims.role) {
        if (options.optional) return next();
        return res.status(401).json({ message: "Malformed token" });
      }
      if (roles && !roles.has(claims.role)) {
        return res.status(403).json({ message: "Forbidden — role not allowed" });
      }
      req.user = {
        id: claims.sub,
        email: claims.email,
        name: claims.name || claims.email,
        role: claims.role,
        department: claims.department ?? null,
        phone: claims.phone ?? null,
        globalRole: claims.globalRole,
        grants: claims.grants ?? [],
        roleOverrides: claims.roleOverrides ?? [],
      };
      next();
    } catch (err) {
      if (options.optional) return next();
      return res.status(401).json({ message: "Invalid or expired token" });
    }
  };
}

/**
 * Helper: redirect-to-login link for the current request.
 * Apps call this in their login redirect routes.
 */
export function loginRedirectUrl(authBaseUrl: string, returnTo: string): string {
  const base = authBaseUrl.replace(/\/$/, "");
  return `${base}/?next=${encodeURIComponent(returnTo)}`;
}
