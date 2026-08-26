/**
 * Smoke test: patch-notes-announcer emits hash-form links.
 *
 * Bulldog Chat is a hash-routed SPA. External /whats-new links from email
 * and push must use the hash form (`/#/whats-new`) so wouter's internal
 * <Router hook={useHashLocation}> matches the route. Path-form links
 * (`/whats-new`) land on the SPA fallback with an empty hash, so wouter
 * matches `/` and Home restores the last-active channel — reproducing
 * the user-reported bug where "See the full list" opened chat home.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const src = readFileSync(
  resolve(__dirname, "..", "server", "patch-notes-announcer.ts"),
  "utf8",
);

// Email body link (buildEmailBody).
assert.ok(
  /const link = `\$\{base\}\/#\/whats-new`;/.test(src),
  "buildEmailBody must emit hash-form /#/whats-new, not /whats-new",
);
assert.ok(
  !/const link = `\$\{base\}\/whats-new`;/.test(src),
  "buildEmailBody must not emit path-form /whats-new (breaks hash router)",
);

// Push notification URL.
assert.ok(
  /\/#\/whats-new`;\s*$/m.test(src) &&
    /const pushUrl = `\$\{.*\}\/#\/whats-new`;/.test(src),
  "push notification URL must use hash form /#/whats-new",
);
assert.ok(
  !/const pushUrl = `\$\{.*replace\(.*\)\}\/whats-new`;/.test(src),
  "push URL must not use path form /whats-new",
);

// Static server redirect (backfill for stale links already in inboxes).
const staticSrc = readFileSync(
  resolve(__dirname, "..", "server", "static.ts"),
  "utf8",
);
assert.ok(
  /HASH_ROUTE_REDIRECTS/.test(staticSrc) &&
    /"\/whats-new"/.test(staticSrc) &&
    /res\.redirect\(302,\s*`\/#\$\{req\.path\}`\)/.test(staticSrc),
  "static.ts must redirect path-form /whats-new to hash form for stale email links",
);

console.log("OK: /whats-new email + push emit hash form; stale path-form redirects");
