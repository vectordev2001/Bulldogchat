/**
 * graphClient.ts — Microsoft Graph client for the Teams parallel-join feature
 * (Phase 2.1).
 *
 * Authenticates as the "Bulldog Chat Teams Connector" Azure AD app using the
 * client-credentials (application permissions) flow and returns a configured
 * Microsoft Graph client.
 *
 * Lazy + guarded by design: the three MS_GRAPH_* env vars are read at call
 * time, not import time, and if ANY of them is missing `getGraphClient()`
 * returns null. Callers treat a null client as "Teams integration disabled"
 * and fall back to the Bulldog-only flow. This keeps the chat service booting
 * in dev/standalone environments that have no M365 credentials.
 */
import { ClientSecretCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
// isomorphic-fetch is a peer dependency of the Graph client SDK: it installs a
// global `fetch` for environments that lack one. Importing for side effects.
import "isomorphic-fetch";

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

interface CachedToken {
  token: string;
  // epoch ms at which we should refresh (a little before real expiry)
  expiresAt: number;
}

let cachedCredential: ClientSecretCredential | null = null;
let cachedToken: CachedToken | null = null;

function readEnv(): { tenantId: string; clientId: string; clientSecret: string } | null {
  const tenantId = process.env.MS_GRAPH_TENANT_ID?.trim();
  const clientId = process.env.MS_GRAPH_CLIENT_ID?.trim();
  const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET?.trim();
  if (!tenantId || !clientId || !clientSecret) return null;
  return { tenantId, clientId, clientSecret };
}

/** True when all three MS Graph env vars are present. */
export function isTeamsConfigured(): boolean {
  return readEnv() !== null;
}

function getCredential(): ClientSecretCredential | null {
  const env = readEnv();
  if (!env) return null;
  if (!cachedCredential) {
    cachedCredential = new ClientSecretCredential(env.tenantId, env.clientId, env.clientSecret);
  }
  return cachedCredential;
}

async function getAccessToken(): Promise<string | null> {
  const credential = getCredential();
  if (!credential) return null;
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.token;
  }
  const result = await credential.getToken(GRAPH_SCOPE);
  if (!result?.token) return null;
  // Refresh 5 minutes before the real expiry to avoid edge-of-expiry failures.
  const expiresAt = (result.expiresOnTimestamp ?? now + 3600_000) - 5 * 60_000;
  cachedToken = { token: result.token, expiresAt };
  return result.token;
}

/**
 * Returns an authenticated Microsoft Graph client, or null if the MS Graph
 * env vars are missing or a token could not be acquired. Never throws — a null
 * return is the signal to fall back to the Bulldog-only flow.
 */
export async function getGraphClient(): Promise<Client | null> {
  if (!isTeamsConfigured()) return null;
  try {
    const client = Client.init({
      authProvider: async (done) => {
        try {
          const token = await getAccessToken();
          if (!token) {
            done(new Error("MS Graph token acquisition returned empty token"), null);
            return;
          }
          done(null, token);
        } catch (err) {
          done(err as Error, null);
        }
      },
    });
    return client;
  } catch (err) {
    console.warn("[teams] getGraphClient failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
