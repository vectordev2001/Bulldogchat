// Bogey Help Desk knowledge base search.
//
// The KB is a folder of markdown files under docs/bogey-kb/. On boot we read
// each file into memory once and score against a query using a simple
// term-frequency match. This is small (~10 files) so a linear scan is fine
// and avoids pulling in a search dependency.
//
// A "match" returns up to 3 files, each with a short snippet (~300 chars)
// around the strongest keyword hit. Bogey formats these into the chat reply.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

type KbDoc = {
  slug: string;
  title: string;
  path: string;
  body: string;
  bodyLower: string;
};

let CACHE: KbDoc[] | null = null;

function candidateDirs(): string[] {
  // Support both dev (server/../docs) and production build layouts. We check
  // a few common locations rather than hard-coding one.
  const cwd = process.cwd();
  return [
    path.join(cwd, "docs", "bogey-kb"),
    path.join(cwd, "..", "docs", "bogey-kb"),
    path.join(__dirname, "..", "docs", "bogey-kb"),
    path.join(__dirname, "..", "..", "docs", "bogey-kb"),
  ];
}

function loadKb(): KbDoc[] {
  if (CACHE) return CACHE;
  let dir: string | null = null;
  for (const d of candidateDirs()) {
    if (existsSync(d)) {
      dir = d;
      break;
    }
  }
  if (!dir) {
    CACHE = [];
    return CACHE;
  }
  const docs: KbDoc[] = [];
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md",
  );
  for (const f of files) {
    try {
      const body = readFileSync(path.join(dir, f), "utf-8");
      const firstHeading =
        body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? f.replace(/\.md$/, "");
      docs.push({
        slug: f.replace(/\.md$/, ""),
        title: firstHeading,
        path: `docs/bogey-kb/${f}`,
        body,
        bodyLower: body.toLowerCase(),
      });
    } catch {
      // skip unreadable file
    }
  }
  CACHE = docs;
  return CACHE;
}

// Force a reload — used only in tests / dev.
export function clearKbCache(): void {
  CACHE = null;
}

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "how",
  "what",
  "why",
  "when",
  "where",
  "with",
  "that",
  "this",
  "does",
  "should",
  "can",
  "you",
  "your",
  "our",
  "have",
  "from",
  "into",
  "onto",
  "about",
]);

function scoreDoc(doc: KbDoc, terms: string[]): number {
  let s = 0;
  for (const term of terms) {
    const titleHits = doc.title.toLowerCase().split(term).length - 1;
    const bodyHits = doc.bodyLower.split(term).length - 1;
    // Title hits count 5x — matches on the topic name matter a lot.
    s += titleHits * 5 + bodyHits;
  }
  return s;
}

function extractSnippet(doc: KbDoc, terms: string[], radius = 180): string {
  // Find the earliest occurrence of any term, then return a window around it.
  let idx = -1;
  for (const term of terms) {
    const i = doc.bodyLower.indexOf(term);
    if (i >= 0 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx < 0) {
    return doc.body.slice(0, radius * 2).trim();
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(doc.body.length, idx + radius);
  const clip = doc.body.slice(start, end).trim();
  return (start > 0 ? "…" : "") + clip + (end < doc.body.length ? "…" : "");
}

export type KbHit = {
  slug: string;
  title: string;
  path: string;
  snippet: string;
  score: number;
};

export function searchKb(query: string, opts?: { limit?: number }): KbHit[] {
  const q = (query || "").trim();
  if (!q) return [];
  const terms = tokenize(q);
  if (terms.length === 0) return [];
  const docs = loadKb();
  const scored = docs
    .map((d) => ({ doc: d, score: scoreDoc(d, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(5, opts?.limit ?? 3)));

  return scored.map(({ doc, score }) => ({
    slug: doc.slug,
    title: doc.title,
    path: doc.path,
    snippet: extractSnippet(doc, terms),
    score,
  }));
}

// Also expose the loaded doc titles so we can tell Bogey what's available if
// a query returns nothing.
export function listKbTopics(): { slug: string; title: string }[] {
  return loadKb().map((d) => ({ slug: d.slug, title: d.title }));
}
