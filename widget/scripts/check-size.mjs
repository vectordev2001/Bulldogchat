#!/usr/bin/env node
// Bundle-size budget for @vectordev2001/chat-widget.
//
// Fails the build if the sum of dist/*.{js,cjs,css} exceeds the limits below.
// Adjust intentionally when you actually intend to grow — the whole point is
// that "oh it grew 40 kB" is a decision, not a surprise.
//
// Baseline at 0.1.4 (from npm-notice output):
//   dist/index.js  = 42.7 kB
//   dist/index.cjs = 47.0 kB
//   dist/style.css =  9.2 kB
// Total shipped code (js + cjs + css) ≈ 99 kB.

import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "dist");

// Individual per-artifact ceilings.
const LIMITS = {
  "index.js": 60 * 1024,
  "index.cjs": 65 * 1024,
  "style.css": 20 * 1024,
};

// Total ceiling across the three shipped artifacts (js + cjs + css).
const TOTAL_LIMIT = 130 * 1024;

let total = 0;
let failed = false;

for (const [file, limit] of Object.entries(LIMITS)) {
  const path = join(distDir, file);
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    console.error(`::error::Missing expected dist artifact: ${file}`);
    failed = true;
    continue;
  }
  total += size;
  const kb = (size / 1024).toFixed(1);
  const limitKb = (limit / 1024).toFixed(1);
  if (size > limit) {
    console.error(`::error::${file} is ${kb} kB, exceeds ${limitKb} kB ceiling.`);
    failed = true;
  } else {
    console.log(`ok  ${file}  ${kb} kB  (limit ${limitKb} kB)`);
  }
}

const totalKb = (total / 1024).toFixed(1);
const totalLimitKb = (TOTAL_LIMIT / 1024).toFixed(1);
if (total > TOTAL_LIMIT) {
  console.error(`::error::Total dist size is ${totalKb} kB, exceeds ${totalLimitKb} kB budget.`);
  failed = true;
} else {
  console.log(`ok  total  ${totalKb} kB  (budget ${totalLimitKb} kB)`);
}

if (failed) {
  console.error("");
  console.error("Bundle-size budget exceeded. Either:");
  console.error("  1. Trim the change, or");
  console.error("  2. Intentionally raise the limits in widget/scripts/check-size.mjs");
  console.error("     as part of the same PR (so the growth is a reviewed decision).");
  process.exit(1);
}
