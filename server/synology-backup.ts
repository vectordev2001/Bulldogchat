// Synology WebDAV backup for original contract files.
//
// Each ingested contract uploads its original file (PDF/image) to a Synology
// folder over WebDAV. This is best-effort: a failure here NEVER blocks the
// repository upload. Status is recorded on the contract row so the operator
// can retry from the UI for documents that did not back up.
//
// Configuration (all env vars optional):
//   SYNOLOGY_BACKUP_ENABLED        — "true" to enable. Default off.
//   SYNOLOGY_WEBDAV_URL            — base URL, e.g.
//       https://vtsserver.diskstation.me:5006/VTS%20Confidential/Contracts%20Backup
//   SYNOLOGY_WEBDAV_USERNAME       — WebDAV username
//   SYNOLOGY_WEBDAV_PASSWORD       — WebDAV password
//   SYNOLOGY_BACKUP_SUBFOLDER      — optional extra folder appended after the
//                                    base URL, e.g. "Original Contracts"
//   SYNOLOGY_BACKUP_TIMEOUT_MS     — default 60000
//   SYNOLOGY_BACKUP_INSECURE_TLS   — "true" allows self-signed certs (NOT
//                                    recommended; only for staging).
//
// Credentials are never logged.

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { URL } from "node:url";

export interface SynologyBackupResult {
  status: "uploaded" | "disabled" | "misconfigured" | "skipped" | "failed";
  remotePath?: string;
  filename?: string;
  reason?: string;
  attemptedAt: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function isSynologyBackupConfigured(): boolean {
  return Boolean(
    process.env.SYNOLOGY_WEBDAV_URL?.trim() &&
      process.env.SYNOLOGY_WEBDAV_USERNAME?.trim() &&
      process.env.SYNOLOGY_WEBDAV_PASSWORD?.trim(),
  );
}

export function isSynologyBackupEnabled(): boolean {
  const flag = (process.env.SYNOLOGY_BACKUP_ENABLED || "").trim().toLowerCase();
  if (flag === "true" || flag === "1" || flag === "yes" || flag === "on") return true;
  return false;
}

export function getSynologyBackupSubfolder(): string {
  return (process.env.SYNOLOGY_BACKUP_SUBFOLDER || "").trim();
}

export function getSynologyBackupStatusSummary() {
  return {
    enabled: isSynologyBackupEnabled(),
    configured: isSynologyBackupConfigured(),
    subfolder: getSynologyBackupSubfolder(),
    baseUrlSet: Boolean(process.env.SYNOLOGY_WEBDAV_URL?.trim()),
    usernameSet: Boolean(process.env.SYNOLOGY_WEBDAV_USERNAME?.trim()),
    passwordSet: Boolean(process.env.SYNOLOGY_WEBDAV_PASSWORD?.trim()),
  };
}

function getTimeoutMs(): number {
  const raw = Number(process.env.SYNOLOGY_BACKUP_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0 && raw < 600_000) return Math.floor(raw);
  return DEFAULT_TIMEOUT_MS;
}

function insecureTlsAllowed(): boolean {
  const flag = (process.env.SYNOLOGY_BACKUP_INSECURE_TLS || "").trim().toLowerCase();
  return flag === "true" || flag === "1" || flag === "yes";
}

function encodePathSegment(seg: string): string {
  return encodeURIComponent(seg).replace(/%2F/gi, "/");
}

function joinUrlPath(base: string, subSegments: string[]): URL {
  // base may already be URL-encoded (per docs). Append normalized segments.
  const url = new URL(base);
  const basePath = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  const extra = subSegments
    .map((s) => s.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .map(encodePathSegment)
    .join("/");
  url.pathname = extra ? `${basePath}${extra}` : basePath;
  return url;
}

function buildAuthHeader(username: string, password: string): string {
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

interface RequestResult {
  statusCode: number;
  body: string;
}

function sendRequest(
  method: string,
  url: URL,
  options: {
    auth: string;
    timeoutMs: number;
    body?: Buffer;
    contentType?: string;
  },
): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const headers: Record<string, string> = {
      Authorization: options.auth,
      "User-Agent": "bulldog-contracts/1.0 (+synology-backup)",
    };
    if (options.body) {
      headers["Content-Length"] = String(options.body.length);
      headers["Content-Type"] = options.contentType || "application/octet-stream";
    }
    const req = lib.request(
      {
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers,
        rejectUnauthorized: isHttps ? !insecureTlsAllowed() : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", (err) => reject(err));
    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${options.timeoutMs}ms`));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function ensureCollection(url: URL, auth: string, timeoutMs: number): Promise<void> {
  // MKCOL is idempotent here — 201 created, 405 already exists. Both are OK.
  const result = await sendRequest("MKCOL", url, { auth, timeoutMs });
  if (
    result.statusCode === 201 ||
    result.statusCode === 200 ||
    result.statusCode === 204 ||
    result.statusCode === 405 ||
    result.statusCode === 301 ||
    result.statusCode === 302
  ) {
    return;
  }
  if (result.statusCode === 401 || result.statusCode === 403) {
    throw new Error(`WebDAV auth rejected MKCOL (HTTP ${result.statusCode})`);
  }
  // Some servers return 409 if the parent doesn't exist; we don't handle deep
  // path creation here — operator should pre-create the base folder. Treat
  // 409 as "parent missing" for clarity.
  if (result.statusCode === 409) {
    throw new Error(
      `WebDAV MKCOL returned 409 — parent folder missing on the Synology server`,
    );
  }
  throw new Error(`WebDAV MKCOL failed (HTTP ${result.statusCode})`);
}

// Creates each folder level under the base URL, in order. Idempotent: a
// 405/200/204 (already exists) is treated as success. Stops on hard auth
// failures so the caller can surface a clean error instead of looping.
async function ensureCollectionTree(
  baseUrl: string,
  segments: string[],
  auth: string,
  timeoutMs: number,
): Promise<void> {
  const cleaned = segments.map((s) => s.replace(/^\/+|\/+$/g, "")).filter(Boolean);
  for (let i = 1; i <= cleaned.length; i++) {
    const url = joinUrlPath(baseUrl, cleaned.slice(0, i));
    if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
    await ensureCollection(url, auth, timeoutMs);
  }
}

export interface UploadOriginalParams {
  filePath: string;
  remoteFilename: string;
  contentType?: string;
  // Extra folder segments (e.g. [companyFolder, customerFolder]) appended
  // after the configured base URL and SYNOLOGY_BACKUP_SUBFOLDER. Each level
  // is created via MKCOL before the PUT. Segments are joined with "/".
  folderSegments?: string[];
}

// Uploads the local file to the configured Synology WebDAV folder.
// Returns a structured result so callers can persist status without throwing.
export async function uploadOriginalToSynology(
  params: UploadOriginalParams,
): Promise<SynologyBackupResult> {
  const attemptedAt = new Date().toISOString();

  if (!isSynologyBackupEnabled()) {
    return { status: "disabled", reason: "SYNOLOGY_BACKUP_ENABLED is not true", attemptedAt };
  }
  if (!isSynologyBackupConfigured()) {
    return {
      status: "misconfigured",
      reason:
        "Missing one or more of SYNOLOGY_WEBDAV_URL, SYNOLOGY_WEBDAV_USERNAME, SYNOLOGY_WEBDAV_PASSWORD",
      attemptedAt,
    };
  }
  if (!params.filePath || !fs.existsSync(params.filePath)) {
    return { status: "skipped", reason: "Local file missing", attemptedAt };
  }
  if (!params.remoteFilename || !/^[A-Za-z0-9._\-]+$/.test(params.remoteFilename.replace(/[^A-Za-z0-9._\-]/g, ""))) {
    // We can't reject here based on the regex result alone; just guard against empty.
    if (!params.remoteFilename) {
      return { status: "skipped", reason: "Empty remote filename", attemptedAt };
    }
  }

  const baseUrl = (process.env.SYNOLOGY_WEBDAV_URL || "").trim();
  const username = (process.env.SYNOLOGY_WEBDAV_USERNAME || "").trim();
  const password = (process.env.SYNOLOGY_WEBDAV_PASSWORD || "").trim();
  const subfolder = getSynologyBackupSubfolder();
  const timeoutMs = getTimeoutMs();

  let auth: string;
  try {
    auth = buildAuthHeader(username, password);
  } catch (err) {
    return {
      status: "failed",
      reason: `Could not build auth header: ${err instanceof Error ? err.message : "unknown error"}`,
      attemptedAt,
    };
  }

  const extraFolderSegments = (params.folderSegments || [])
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
  // Segments in order: optional SYNOLOGY_BACKUP_SUBFOLDER, then any
  // caller-provided segments (e.g. company / customer).
  const folderChain = [
    ...(subfolder ? [subfolder] : []),
    ...extraFolderSegments,
  ];

  let folderUrl: URL;
  let fileUrl: URL;
  try {
    folderUrl = folderChain.length
      ? joinUrlPath(baseUrl, folderChain)
      : new URL(baseUrl);
    if (!folderUrl.pathname.endsWith("/")) {
      folderUrl.pathname = `${folderUrl.pathname}/`;
    }
    fileUrl = joinUrlPath(baseUrl, [...folderChain, params.remoteFilename]);
  } catch (err) {
    return {
      status: "misconfigured",
      reason: `Invalid SYNOLOGY_WEBDAV_URL: ${err instanceof Error ? err.message : "unknown error"}`,
      attemptedAt,
    };
  }

  if (folderUrl.protocol !== "https:" && folderUrl.protocol !== "http:") {
    return {
      status: "misconfigured",
      reason: `SYNOLOGY_WEBDAV_URL must use http(s). Got protocol "${folderUrl.protocol}"`,
      attemptedAt,
    };
  }

  let body: Buffer;
  try {
    body = fs.readFileSync(params.filePath);
  } catch (err) {
    return {
      status: "failed",
      reason: `Could not read local file: ${err instanceof Error ? err.message : "unknown error"}`,
      attemptedAt,
    };
  }

  try {
    if (folderChain.length) {
      try {
        await ensureCollectionTree(baseUrl, folderChain, auth, timeoutMs);
      } catch (err) {
        // Folder may already exist via PROPFIND-only servers; we tolerated 405
        // already. Re-raise hard auth/parent issues.
        const msg = err instanceof Error ? err.message : "MKCOL failed";
        if (/HTTP 401|HTTP 403/.test(msg)) {
          return { status: "failed", reason: msg, attemptedAt };
        }
        if (/parent folder missing/.test(msg)) {
          return { status: "failed", reason: msg, attemptedAt };
        }
        // Otherwise proceed and let PUT surface the real error.
      }
    }

    const put = await sendRequest("PUT", fileUrl, {
      auth,
      timeoutMs,
      body,
      contentType: params.contentType || "application/octet-stream",
    });

    if (put.statusCode === 200 || put.statusCode === 201 || put.statusCode === 204) {
      return {
        status: "uploaded",
        remotePath: fileUrl.pathname,
        filename: params.remoteFilename,
        attemptedAt,
      };
    }

    if (put.statusCode === 401 || put.statusCode === 403) {
      return {
        status: "failed",
        reason: `WebDAV auth rejected (HTTP ${put.statusCode}) — check SYNOLOGY_WEBDAV_USERNAME/PASSWORD and folder permissions`,
        attemptedAt,
      };
    }

    return {
      status: "failed",
      reason: `WebDAV PUT failed (HTTP ${put.statusCode})`,
      attemptedAt,
    };
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : "Unknown error during WebDAV upload",
      attemptedAt,
    };
  }
}

// Convenience for environments that just need the URL safely shaped.
// Optionally accepts extra folder segments (e.g. [company, customer]) so the
// rendered path matches the actual upload location.
export function describeRemoteTarget(
  remoteFilename: string,
  folderSegments?: string[],
): string {
  const base = (process.env.SYNOLOGY_WEBDAV_URL || "").trim();
  const subfolder = getSynologyBackupSubfolder();
  const extras = (folderSegments || []).map((s) => (s || "").trim()).filter(Boolean);
  if (!base) {
    const joined = [...(subfolder ? [subfolder] : []), ...extras, remoteFilename].join("/");
    return joined || remoteFilename;
  }
  try {
    const segments = [
      ...(subfolder ? [subfolder] : []),
      ...extras,
      remoteFilename,
    ];
    return joinUrlPath(base, segments).pathname;
  } catch {
    return remoteFilename;
  }
}

// ---------------------------------------------------------------------------
// Read-only WebDAV listing + quota helpers used by the backup verification
// dashboard. These never mutate the remote tree.
// ---------------------------------------------------------------------------

export interface SynologyListedEntry {
  // Decoded path segment under the configured backup root, e.g.
  // "Vector Services/ABC Construction/file.pdf" (no leading slash).
  relativePath: string;
  // Final path component (already URL-decoded).
  name: string;
  isDirectory: boolean;
  size: number | null;
  lastModified: string | null;
}

export interface SynologyQuotaInfo {
  quotaUsedBytes: number | null;
  quotaAvailableBytes: number | null;
  quotaTotalBytes: number | null;
  percentUsed: number | null;
}

export interface SynologyConnectivity {
  ok: boolean;
  statusCode?: number;
  reason?: string;
}

function decodeRelativePath(absolutePath: string, basePath: string): string {
  let abs: string;
  let base: string;
  try {
    abs = decodeURIComponent(absolutePath);
  } catch {
    abs = absolutePath;
  }
  try {
    base = decodeURIComponent(basePath);
  } catch {
    base = basePath;
  }
  if (!base.endsWith("/")) base = `${base}/`;
  if (abs.startsWith(base)) return abs.slice(base.length).replace(/^\/+|\/+$/g, "");
  return abs.replace(/^\/+/, "");
}

interface ParsedResponse {
  href: string;
  isDirectory: boolean;
  size: number | null;
  lastModified: string | null;
}

function parsePropfindXml(xml: string, basePath: string): SynologyListedEntry[] {
  const out: SynologyListedEntry[] = [];
  const responseRe = /<([A-Za-z0-9]+:)?response\b[^>]*>([\s\S]*?)<\/\1?response>/g;
  let m: RegExpExecArray | null;
  let isFirst = true;
  while ((m = responseRe.exec(xml)) !== null) {
    const block = m[2];
    const hrefMatch = /<([A-Za-z0-9]+:)?href[^>]*>([\s\S]*?)<\/\1?href>/i.exec(block);
    if (!hrefMatch) continue;
    const href = hrefMatch[2].trim();
    const isDir = /<([A-Za-z0-9]+:)?resourcetype\b[^>]*>[\s\S]*?<([A-Za-z0-9]+:)?collection\b[^>]*\/?>[\s\S]*?<\/\1?resourcetype>/i.test(block);
    const lenMatch = /<([A-Za-z0-9]+:)?getcontentlength[^>]*>([\s\S]*?)<\/\1?getcontentlength>/i.exec(block);
    const modMatch = /<([A-Za-z0-9]+:)?getlastmodified[^>]*>([\s\S]*?)<\/\1?getlastmodified>/i.exec(block);

    let absolutePath = href;
    try {
      if (/^https?:\/\//i.test(href)) absolutePath = new URL(href).pathname;
    } catch {
      // ignore
    }
    const relativePath = decodeRelativePath(absolutePath, basePath);
    const parts = relativePath.split("/").filter(Boolean);
    const name = parts.length ? parts[parts.length - 1] : "";
    const size = lenMatch ? Number(lenMatch[2].trim()) : NaN;
    // Skip the self-entry (the requested directory itself).
    if (isFirst && isDir) {
      isFirst = false;
      continue;
    }
    isFirst = false;
    out.push({
      relativePath,
      name,
      isDirectory: isDir,
      size: Number.isFinite(size) ? size : null,
      lastModified: modMatch ? modMatch[2].trim() : null,
    });
  }
  return out;
}

async function propfind(
  url: URL,
  auth: string,
  timeoutMs: number,
  depth: "0" | "1",
  body?: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const headers: Record<string, string> = {
      Authorization: auth,
      "User-Agent": "bulldog-contracts/1.0 (+synology-backup-verify)",
      Depth: depth,
      "Content-Type": 'application/xml; charset="utf-8"',
    };
    const payload = body ? Buffer.from(body, "utf8") : undefined;
    if (payload) headers["Content-Length"] = String(payload.length);
    const req = lib.request(
      {
        method: "PROPFIND",
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers,
        rejectUnauthorized: isHttps ? !insecureTlsAllowed() : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", (err) => reject(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function getBaseUrlOrThrow(): URL {
  const base = (process.env.SYNOLOGY_WEBDAV_URL || "").trim();
  if (!base) throw new Error("SYNOLOGY_WEBDAV_URL is not set");
  return new URL(base);
}

function buildAuthFromEnv(): string {
  const username = (process.env.SYNOLOGY_WEBDAV_USERNAME || "").trim();
  const password = (process.env.SYNOLOGY_WEBDAV_PASSWORD || "").trim();
  return buildAuthHeader(username, password);
}

function rootBackupUrl(): URL {
  const base = getBaseUrlOrThrow();
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
  const subfolder = getSynologyBackupSubfolder();
  const rootUrl = subfolder
    ? joinUrlPath(base.toString(), [subfolder])
    : new URL(base.toString());
  if (!rootUrl.pathname.endsWith("/")) rootUrl.pathname = `${rootUrl.pathname}/`;
  return rootUrl;
}

// Lightweight reachability check: Depth: 0 PROPFIND against the configured
// backup root. Never enumerates children.
export async function pingSynologyWebdav(): Promise<SynologyConnectivity> {
  if (!isSynologyBackupConfigured()) {
    return { ok: false, reason: "Synology backup credentials are not configured" };
  }
  const timeoutMs = getTimeoutMs();
  try {
    const root = rootBackupUrl();
    const result = await propfind(root, buildAuthFromEnv(), timeoutMs, "0");
    if (result.statusCode >= 200 && result.statusCode < 300) {
      return { ok: true, statusCode: result.statusCode };
    }
    if (result.statusCode === 401 || result.statusCode === 403) {
      return {
        ok: false,
        statusCode: result.statusCode,
        reason: `WebDAV auth rejected (HTTP ${result.statusCode})`,
      };
    }
    return {
      ok: false,
      statusCode: result.statusCode,
      reason: `WebDAV PROPFIND failed (HTTP ${result.statusCode})`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Unknown error contacting Synology",
    };
  }
}

// Recursively walks the configured backup root and returns every file under
// it. One Depth: 1 PROPFIND per directory; `maxFiles`/`maxDirs` cap the walk.
export async function listSynologyBackupFiles(opts?: {
  maxFiles?: number;
  maxDirs?: number;
}): Promise<{ files: SynologyListedEntry[]; truncated: boolean; error?: string }> {
  const maxFiles = opts?.maxFiles && opts.maxFiles > 0 ? opts.maxFiles : 25_000;
  const maxDirs = opts?.maxDirs && opts.maxDirs > 0 ? opts.maxDirs : 5_000;
  const timeoutMs = getTimeoutMs();
  if (!isSynologyBackupConfigured()) {
    return { files: [], truncated: false, error: "Synology backup credentials are not configured" };
  }
  const root = rootBackupUrl();
  const rootBasePath = root.pathname;
  const auth = buildAuthFromEnv();

  const files: SynologyListedEntry[] = [];
  const queue: string[] = [""];
  const visited = new Set<string>();
  let dirCount = 0;

  while (queue.length) {
    if (files.length >= maxFiles || dirCount >= maxDirs) {
      return { files, truncated: true };
    }
    const relDir = queue.shift()!;
    if (visited.has(relDir)) continue;
    visited.add(relDir);
    dirCount += 1;
    const dirUrl = relDir
      ? joinUrlPath(root.toString(), relDir.split("/").filter(Boolean))
      : new URL(root.toString());
    if (!dirUrl.pathname.endsWith("/")) dirUrl.pathname = `${dirUrl.pathname}/`;
    let resp;
    try {
      resp = await propfind(dirUrl, auth, timeoutMs, "1");
    } catch (err) {
      return {
        files,
        truncated: false,
        error: err instanceof Error ? err.message : "PROPFIND failed",
      };
    }
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      if (resp.statusCode === 404) continue;
      return {
        files,
        truncated: false,
        error: `WebDAV PROPFIND ${dirUrl.pathname} failed (HTTP ${resp.statusCode})`,
      };
    }
    const entries = parsePropfindXml(resp.body, rootBasePath);
    for (const entry of entries) {
      if (entry.isDirectory) {
        queue.push(entry.relativePath);
      } else {
        files.push(entry);
        if (files.length >= maxFiles) return { files, truncated: true };
      }
    }
  }

  return { files, truncated: false };
}

// RFC 4331 quota properties. Returns nulls when the server omits them.
export async function getSynologyQuota(): Promise<SynologyQuotaInfo> {
  const empty: SynologyQuotaInfo = {
    quotaUsedBytes: null,
    quotaAvailableBytes: null,
    quotaTotalBytes: null,
    percentUsed: null,
  };
  if (!isSynologyBackupConfigured()) return empty;
  const timeoutMs = getTimeoutMs();
  try {
    const root = rootBackupUrl();
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<D:propfind xmlns:D="DAV:">' +
      "<D:prop>" +
      "<D:quota-used-bytes/>" +
      "<D:quota-available-bytes/>" +
      "</D:prop>" +
      "</D:propfind>";
    const resp = await propfind(root, buildAuthFromEnv(), timeoutMs, "0", body);
    if (resp.statusCode < 200 || resp.statusCode >= 300) return empty;
    const usedMatch = /<([A-Za-z0-9]+:)?quota-used-bytes[^>]*>([\s\S]*?)<\/\1?quota-used-bytes>/i.exec(resp.body);
    const availMatch = /<([A-Za-z0-9]+:)?quota-available-bytes[^>]*>([\s\S]*?)<\/\1?quota-available-bytes>/i.exec(resp.body);
    const used = usedMatch ? Number(usedMatch[2].trim()) : NaN;
    const avail = availMatch ? Number(availMatch[2].trim()) : NaN;
    const usedNum = Number.isFinite(used) ? used : null;
    const availNum = Number.isFinite(avail) ? avail : null;
    const total =
      usedNum !== null && availNum !== null ? usedNum + availNum : null;
    const percent =
      usedNum !== null && total && total > 0
        ? Math.round((usedNum / total) * 1000) / 10
        : null;
    return {
      quotaUsedBytes: usedNum,
      quotaAvailableBytes: availNum,
      quotaTotalBytes: total,
      percentUsed: percent,
    };
  } catch {
    return empty;
  }
}

// Exported for tests.
export const _internal = {
  encodePathSegment,
  joinUrlPath,
  buildAuthHeader,
  getTimeoutMs,
  ensureCollectionTree,
  parsePropfindXml,
  decodeRelativePath,
};
