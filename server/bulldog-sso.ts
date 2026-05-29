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
import { bulldogAuth } from "./bulldog-sdk";
import { storage } from "./storage";
import { AUTH_COOKIE, signJwt, setAuthCookie, verifyJwt } from "./auth";

const AUTH_BASE = process.env.BULLDOG_AUTH_URL || "https://auth.bulldogops.com";

const optionalVerifier: RequestHandler = bulldogAuth({
  authBaseUrl: AUTH_BASE,
  optional: true,
});

function extractBearerOrCookie(req: Request): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`));
    if (m) return decodeURIComponent(m[1]);
  }
  if (typeof req.query.token === "string" && req.query.token) return req.query.token;
  return null;
}

function hasValidChatToken(req: Request): boolean {
  const t = extractBearerOrCookie(req);
  if (!t) return false;
  // A token is "chat" only if our HS256 verifier accepts it. Bulldog-auth
  // tokens are RS256 and will fail here — falling through to the SSO bridge.
  return verifyJwt(t) !== null;
}

export function bulldogSsoBridge(): RequestHandler {
  return async function (req: Request, res: Response, next: NextFunction) {
    // If the caller already has a valid chat-issued token, let the normal
    // auth pipeline handle it.
    if (hasValidChatToken(req)) return next();

    optionalVerifier(req, res, async (err?: unknown) => {
      if (err) return next();
      try {
        if (!req.user?.email) return next();
        const emailLower = req.user.email.toLowerCase();
        let local = storage.getUserByEmail(emailLower);
        if (!local) {
          // First-time SSO landing — provision a local shadow user so the rest
          // of chat (messages, project_members, etc.) has someone to attach to.
          try {
            // Map bulldog-auth roles to chat roles. Chat enum: admin/foreman/office/field/safety.
            const ssoRole = (req.user.role || "").toLowerCase();
            const chatRole: "admin" | "foreman" | "office" | "field" | "safety" =
              ssoRole === "admin" ? "admin"
              : ssoRole === "manager" ? "office"
              : ssoRole === "foreman" ? "foreman"
              : ssoRole === "safety" ? "safety"
              : "field";
            local = storage.createUser({
              orgId: 1, // single-org install
              email: emailLower,
              passwordHash: "", // SSO-only; local password login disabled for this row
              name: req.user.name || emailLower,
              role: chatRole,
            });
          } catch (e) {
            console.error("[chat bulldogSsoBridge] provision failed:", e);
            return next();
          }
        }
        if (!local) return next();
        // Issue a chat JWT and set the vc_token cookie for subsequent requests.
        const token = signJwt(local.id);
        setAuthCookie(res, token);
        // Make the token available to the current request too.
        req.headers.authorization = `Bearer ${token}`;
        // Clear req.user set by optionalVerifier so requireAuth re-reads from
        // the chat token (which carries the local numeric id).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (req as any).user;
        next();
      } catch (e) {
        console.error("[chat bulldogSsoBridge] error:", e);
        next();
      }
    });
  };
}

export const BULLDOG_AUTH_URL = AUTH_BASE;
