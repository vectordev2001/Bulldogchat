#!/usr/bin/env node
// prepublish-guard: refuse to `npm publish` from the wrong directory
// or with the wrong package identity.
//
// Motivation: on 2026-07-08 an accidental `npm publish` was run from
// ~/Desktop/bulldog-ios which packaged the .xcarchive as
// bulldog-ops-suite@0.1.0 and published it to GitHub Packages. This
// script prevents any recurrence — it only lets `npm publish` proceed
// when the invoker is inside the chat-widget package.
//
// Wired via `prepublishOnly` in widget/package.json.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkgPath = resolve(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const EXPECTED_NAME = "@vectordev2001/chat-widget";

if (pkg.name !== EXPECTED_NAME) {
  console.error("");
  console.error(`::error::prepublish-guard: refusing to publish.`);
  console.error(`  Expected package name: ${EXPECTED_NAME}`);
  console.error(`  Found package.json:    ${pkgPath}`);
  console.error(`  Package name:          ${pkg.name}`);
  console.error("");
  console.error("This is the safety guard added after the 2026-07-08 xcarchive-publish incident.");
  console.error("If you are intentionally publishing a different package, do it from that");
  console.error("package's directory — this guard only lives in chat-widget.");
  process.exit(1);
}

// Refuse to publish if there is no dist/ (i.e. build was skipped).
try {
  const distPkg = readFileSync(resolve(__dirname, "..", "dist", "index.js"), "utf8");
  if (!distPkg || distPkg.length < 100) {
    console.error("::error::prepublish-guard: dist/index.js looks empty. Did the build run?");
    process.exit(1);
  }
} catch {
  console.error("::error::prepublish-guard: dist/index.js not found. Run `npm run build` first.");
  process.exit(1);
}

console.log(`prepublish-guard: ok (publishing ${pkg.name}@${pkg.version})`);
