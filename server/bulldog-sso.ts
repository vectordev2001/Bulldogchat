/**
 * Bulldog SSO bridge for vector-chat.
 *
 * When the user lands here without a `vc_token` cookie but has a valid
 * `bulldog_access` JWT cookie from auth.bulldogops.com, this middleware:
 *   1. Verifies the bulldog JWT against the public key.
 *   2. Resolves the matching local user by email.
 *   3. Issues a fresh vc_token cookie so the rest of the app works
 *      unchanged.
 *
 * Mount BEFORE any requireAuth-guarded route. Cheap — exits early if a
 * vc_token cookie is already set.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { bulldogAuth } from "@bulldog/auth-client";
import { storage } from "./storage";
import { AUTH_COOKIE, signJwt, setAuthCookie } from "./auth";

const AUTH_BASE = process.env.BULLDOG_AUTH_URL || "https://auth.bulldogops.com";

const optionalVerifier: RequestHandler = bulldogAuth({
  authBaseUrl: AUTH_BASE,
  optional: true,
});

function hasChatToken(req: Request): boolean {
  // 1. Auth header
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return true;
  // 2. Cookie
  const cookieHeader = req.headers.cookie;
  if (cookieHeader && new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=`).test(cookieHeader)) return true;
  // 3. Query token (EventSource)
  if (typeof req.query.token === "string" && req.query.token) return true;
  return false;
}

export function bulldogSsoBridge(): RequestHandler {
  return async function (req: Request, res: Response, next: NextFunction) {
    if (hasChatToken(req)) return next();

    optionalVerifier(req, res, async (err?: unknown) => {
      if (err) return next();
      try {
        if (!req.user?.email) return next();
        const local = storage.getUserByEmail(req.user.email.toLowerCase());
        if (!local) return next();
        // Issue a chat JWT and set the vc_token cookie for subsequent requests.
        const token = signJwt(local.id);
        setAuthCookie(res, token);
        // Make the token available to the current request too.
        req.headers.authorization = `Bearer ${token}`;
        next();
      } catch (e) {
        console.error("[chat bulldogSsoBridge] error:", e);
        next();
      }
    });
  };
}

export const BULLDOG_AUTH_URL = AUTH_BASE;
