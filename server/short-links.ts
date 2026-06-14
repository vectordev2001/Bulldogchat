/**
 * Server-side short links for SMS join URLs.
 *
 * The signed-JWT join URL is ~280 chars; wrapping it with the bulldogchat://
 * app deep link pushed scheduled invites to ~5 Twilio segments. A short token
 * that 302-redirects to the long URL lets the SMS carry a single short https://
 * link that works in real Safari, Android, desktop, and the native iOS app
 * (via the in-app browser's "Open in Bulldog app" banner).
 */
import crypto from "crypto";
import { rawDb } from "./db";

// No 0/O/1/I/l — ambiguity-free for anyone who has to read or re-type a link.
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const TOKEN_LEN = 7; // 56^7 ≈ 1.7e12 — collision-safe at our scale

function genToken(): string {
  const bytes = crypto.randomBytes(TOKEN_LEN);
  let out = "";
  for (let i = 0; i < TOKEN_LEN; i++) {
    out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  }
  return out;
}

export interface ShortLinkRow {
  token: string;
  long_url: string;
  scheduled_call_id: number | null;
  created_at: number;
  expires_at: number;
  uses: number;
}

/**
 * Mint a short token that redirects to `longUrl`. Tokens live for `ttlMs`
 * (default: 30 days) — long enough to cover scheduled meetings booked weeks
 * out plus the meeting itself plus a generous reminder window. Retries on
 * the (extremely unlikely) collision; bails after 5 attempts.
 */
export function mintShortLink(longUrl: string, opts?: {
  scheduledCallId?: number | null;
  ttlMs?: number;
}): string {
  const now = Date.now();
  const ttl = opts?.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
  const expiresAt = now + ttl;
  const scheduledCallId = opts?.scheduledCallId ?? null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = genToken();
    try {
      rawDb.prepare(
        "INSERT INTO join_short_links (token, long_url, scheduled_call_id, created_at, expires_at, uses) VALUES (?, ?, ?, ?, ?, 0)"
      ).run(token, longUrl, scheduledCallId, now, expiresAt);
      return token;
    } catch (e: any) {
      if (e?.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || e?.code === "SQLITE_CONSTRAINT_UNIQUE") continue;
      throw e;
    }
  }
  throw new Error("short-link: failed to mint unique token after 5 attempts");
}

export function resolveShortLink(token: string): ShortLinkRow | null {
  const row = rawDb.prepare(
    "SELECT * FROM join_short_links WHERE token = ?"
  ).get(token) as ShortLinkRow | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  return row;
}

export function bumpShortLinkUses(token: string): void {
  rawDb.prepare("UPDATE join_short_links SET uses = uses + 1 WHERE token = ?").run(token);
}
