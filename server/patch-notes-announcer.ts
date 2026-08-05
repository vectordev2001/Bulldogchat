/**
 * Patch-notes release announcer (Bulldog Chat).
 *
 * See /tmp/bulldog-contracts/server/patch-notes-announcer.ts for the full
 * rationale — this is the same design ported to chat's schema.
 *
 * Chat does NOT have a first-class in-app notification inbox like contracts
 * does. What it does have:
 *   - A sparkle icon in the header with a "new" dot driven by localStorage
 *     (client/src/components/PatchNotesTrigger.tsx). That already fires
 *     automatically when the JSON on the client changes, so we don't need
 *     to touch it.
 *   - Web push + Expo push + APNs fan-out via server/push.ts.
 *   - Email via server/email.ts.
 *
 * So "notify users when patch notes drop" in chat means: fire one push to
 * every user + one email per user. The sparkle dot handles the in-app cue.
 *
 * Dedupe + first-run safety mirror the contracts implementation exactly.
 */

import fs from "node:fs";
import path from "node:path";
import { rawDb } from "./db";
import { storage } from "./storage";
import { sendEmail, isEmailConfigured, emailFromName } from "./email";
import { sendNotificationToUsers } from "./push";
import type { User } from "@shared/schema";

interface PatchNoteEntry {
  number: number;
  title: string;
  raw_title?: string;
  summary?: string;
  merged_at?: string;
  author?: string;
  url?: string;
  category?: string;
}
interface PatchNotesFile {
  generated_at?: string;
  repo?: string;
  notes: PatchNoteEntry[];
}

function locatePatchNotesJson(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "client/src/generated/patch-notes.json"),
    path.resolve(process.cwd(), "dist/patch-notes.json"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore
    }
  }
  return null;
}

function loadPatchNotes(): PatchNotesFile | null {
  const file = locatePatchNotesJson();
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.notes)) return null;
    return parsed as PatchNotesFile;
  } catch (err) {
    console.warn("[patch-notes] failed to read", file, err);
    return null;
  }
}

function ensureSystemStateTable(): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `);
}

function readLastNotifiedNumber(): number | null {
  const row = rawDb
    .prepare(`SELECT value FROM system_state WHERE key = 'patch_notes_last_notified'`)
    .get() as { value: string } | undefined;
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : 0;
}

function writeLastNotifiedNumber(n: number): void {
  const now = new Date().toISOString();
  rawDb
    .prepare(
      `INSERT INTO system_state (key, value, updated_at)
       VALUES ('patch_notes_last_notified', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(String(n), now);
}

/** Every non-deactivated user across every org — patch notes are app-wide. */
function listAllActiveUsers(): User[] {
  try {
    const rows = rawDb
      .prepare(`SELECT id FROM users WHERE deactivated = 0`)
      .all() as { id: number }[];
    if (rows.length === 0) return [];
    return storage.listUsersByIds(rows.map((r) => r.id));
  } catch (err) {
    console.warn("[patch-notes] could not list users:", err);
    return [];
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildEmailBody(newNotes: PatchNoteEntry[]): {
  subject: string;
  text: string;
  html: string;
} {
  const base = (process.env.CHAT_BASE_URL || "https://chat.bulldogops.com").replace(/\/+$/, "");
  const link = `${base}/whats-new`;
  const app = "Bulldog Chat";
  const subject =
    newNotes.length === 1
      ? `What's new in ${app}: ${newNotes[0].title}`
      : `What's new in ${app} (${newNotes.length} updates)`;

  const textLines: string[] = [
    `Hi,`,
    ``,
    newNotes.length === 1
      ? `We just shipped an update to ${app}:`
      : `We just shipped ${newNotes.length} updates to ${app}:`,
    ``,
  ];
  for (const n of newNotes) {
    textLines.push(`• ${n.title}`);
    if (n.summary) textLines.push(`  ${n.summary}`);
  }
  textLines.push(``);
  textLines.push(`See the full list: ${link}`);
  textLines.push(``);
  textLines.push(`— ${emailFromName()}`);

  const items = newNotes
    .map(
      (n) => `
        <li style="margin:0 0 12px 0">
          <div style="font-weight:600;color:#0f172a">${escapeHtml(n.title)}</div>
          ${n.summary ? `<div style="color:#475569;font-size:14px;margin-top:2px">${escapeHtml(n.summary)}</div>` : ""}
        </li>`,
    )
    .join("");
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;max-width:560px">
      <p>Hi,</p>
      <p>${
        newNotes.length === 1
          ? `We just shipped an update to <strong>${escapeHtml(app)}</strong>:`
          : `We just shipped <strong>${newNotes.length}</strong> updates to <strong>${escapeHtml(app)}</strong>:`
      }</p>
      <ul style="padding-left:18px;margin:8px 0 16px 0">${items}</ul>
      <p><a href="${escapeHtml(link)}" style="color:#0090F0">See the full list in ${escapeHtml(app)}</a></p>
      <p style="color:#475569;font-size:12px">— ${escapeHtml(emailFromName())}</p>
    </div>`.trim();

  return { subject, text: textLines.join("\n"), html };
}

export async function announcePatchNotesIfChanged(): Promise<void> {
  try {
    ensureSystemStateTable();

    const patchFile = loadPatchNotes();
    if (!patchFile || patchFile.notes.length === 0) return;
    const maxNumber = patchFile.notes.reduce((m, n) => (n.number > m ? n.number : m), 0);
    if (maxNumber <= 0) return;

    const lastNotified = readLastNotifiedNumber();

    // First run: seed the marker without notifying so we don't blast the
    // entire history at every user on the first deploy of this feature.
    if (lastNotified === null) {
      writeLastNotifiedNumber(maxNumber);
      console.log(
        `[patch-notes] seeded patch_notes_last_notified=${maxNumber} (first run, no announcement sent)`,
      );
      return;
    }

    if (maxNumber <= lastNotified) return;

    const newNotes = patchFile.notes.filter((n) => n.number > lastNotified);
    if (newNotes.length === 0) {
      writeLastNotifiedNumber(maxNumber);
      return;
    }

    const audience = listAllActiveUsers();
    if (audience.length === 0) {
      writeLastNotifiedNumber(maxNumber);
      return;
    }

    // Push fan-out (one send for the whole audience — sendNotificationToUsers
    // handles DND, presence gating, expo, apns, web push in one shot).
    const pushTitle =
      newNotes.length === 1
        ? `What's new: ${newNotes[0].title}`.slice(0, 200)
        : `What's new: ${newNotes.length} updates`.slice(0, 200);
    const pushBody = newNotes
      .slice(0, 3)
      .map((n) => `• ${n.title}`)
      .join("\n")
      .slice(0, 500);
    const pushUrl = `${(process.env.CHAT_BASE_URL || "https://chat.bulldogops.com").replace(/\/+$/, "")}/whats-new`;
    try {
      await sendNotificationToUsers(
        audience.map((u) => u.id),
        {
          title: pushTitle,
          body: pushBody,
          url: pushUrl,
          tag: `patch-notes-${maxNumber}`,
        },
      );
    } catch (err) {
      console.warn("[patch-notes] push fan-out failed:", err);
    }

    // Email fan-out (per-user because sendEmail takes a single "to").
    let emailOk = 0;
    let emailFail = 0;
    if (isEmailConfigured()) {
      const { subject, text, html } = buildEmailBody(newNotes);
      for (const u of audience) {
        if (!u.email) continue;
        try {
          await sendEmail({ to: u.email, subject, text, html });
          emailOk += 1;
        } catch (err) {
          emailFail += 1;
          console.warn("[patch-notes] email failed for user", u.id, err);
        }
      }
    } else {
      console.log("[patch-notes] email not configured; skipping email fan-out");
    }

    writeLastNotifiedNumber(maxNumber);
    console.log(
      `[patch-notes] announced ${newNotes.length} new entr${newNotes.length === 1 ? "y" : "ies"} ` +
        `(up to #${maxNumber}) to ${audience.length} user(s); ` +
        `email: ${emailOk} sent / ${emailFail} failed`,
    );
  } catch (err) {
    console.warn("[patch-notes] announcer aborted:", err);
  }
}
