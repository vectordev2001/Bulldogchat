// Fetches the last 10 merged PRs from GitHub and writes a tidy JSON blob to
// client/src/generated/patch-notes.json. The React app imports that file at
// build time — no runtime GitHub calls, no build-time network dependency for
// deploy environments that don't have a token.
//
// Usage:
//   GITHUB_TOKEN=ghp_... tsx script/generate-patch-notes.ts
//   (Or just run it via `npm run patch-notes:refresh`.)
//
// When the token is absent, the script prints a warning and exits 0 so CI /
// Render builds don't fail. The last committed patch-notes.json is used
// instead.
//
// Automated in CI by .github/workflows/refresh-patch-notes.yml which runs on
// every push to main, then commits the regenerated JSON back with a "[skip ci]"
// marker so the auto-commit doesn't retrigger the workflow.

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

// Hard-coded because this repo IS the source of truth for the Contracts app.
// If we ever fork or rename, update this in one place.
const REPO_OWNER = "vectordev2001";
const REPO_NAME = "Bulldogchat";
const PR_COUNT = 10;

interface RawPr {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  merged_at: string | null;
  user: { login: string } | null;
  labels: Array<{ name: string }>;
}

interface PatchNote {
  number: number;
  title: string; // Cleaned, user-facing title
  raw_title: string; // Original PR title, for debugging
  summary: string; // First non-empty paragraph of the PR body, cleaned
  merged_at: string;
  author: string;
  url: string;
  category: "feature" | "fix" | "chore" | "refactor" | "docs" | "other";
}

// Strip conventional-commit prefixes ("feat(contracts): ...", "fix: ...",
// "chore(deps)!: ..."), lower-case scopes, and re-capitalize the first letter
// of what remains so it reads like a headline rather than a git subject.
function cleanTitle(raw: string): { title: string; category: PatchNote["category"] } {
  const trimmed = raw.trim();
  // Match `type(scope)!?: rest` or `type!?: rest`. Scope is optional.
  const match = trimmed.match(/^(\w+)(?:\(([^)]+)\))?!?:\s*(.*)$/);
  if (!match) {
    return { title: capitalizeFirst(trimmed), category: "other" };
  }
  const [, typeRaw, , rest] = match;
  const type = typeRaw.toLowerCase();
  const category =
    type === "feat" ? "feature" :
    type === "fix" ? "fix" :
    type === "chore" ? "chore" :
    type === "refactor" ? "refactor" :
    type === "docs" ? "docs" :
    "other";
  return { title: capitalizeFirst(rest.trim()), category };
}

function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

// Pull the first "meaningful" paragraph out of a PR body. Skips checkbox lists,
// image markdown, and boilerplate GitHub template headings like "## Summary".
function extractSummary(body: string | null | undefined): string {
  if (!body) return "";
  // Normalize line endings so the paragraph regex is deterministic on Windows
  // PR bodies too.
  const normalized = body.replace(/\r\n/g, "\n").trim();
  // Split into blocks on blank lines.
  const blocks = normalized.split(/\n\s*\n/);
  for (const block of blocks) {
    const line = block.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue; // markdown heading
    if (line.startsWith("!")) continue; // image
    if (/^-\s*\[[ xX]\]/.test(line)) continue; // checkbox list item
    if (/^<!--/.test(line)) continue; // HTML comment (PR template hints)
    // Strip inline markdown links -> plain text, code fences, bullet dashes.
    const cleaned = line
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
      .replace(/^[-*]\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length >= 20) {
      // Cap the summary so the UI never gets swamped by a 4-paragraph PR body.
      return cleaned.slice(0, 400);
    }
  }
  return "";
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const outPath = join(process.cwd(), "client/src/generated/patch-notes.json");
  await mkdir(dirname(outPath), { recursive: true });

  if (!token) {
    console.warn(
      "[patch-notes] GITHUB_TOKEN not set; skipping refresh. The last committed patch-notes.json (if any) will be used.",
    );
    return;
  }

  const url = new URL(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls`,
  );
  url.searchParams.set("state", "closed");
  url.searchParams.set("base", "main");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", "50");

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "bulldog-chat-patch-notes",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    console.error(
      `[patch-notes] GitHub API returned ${res.status}: ${await res.text()}`,
    );
    process.exit(1);
  }
  const raw = (await res.json()) as RawPr[];
  const merged = raw
    .filter((pr) => pr.merged_at)
    // Skip release/dependabot bumps by default so the user-facing list is
    // meaningful. Add "user-facing" label to force inclusion later if wanted.
    .filter((pr) => {
      const labels = new Set(pr.labels.map((l) => l.name.toLowerCase()));
      if (labels.has("no-patch-notes")) return false;
      return true;
    })
    .sort(
      (a, b) =>
        new Date(b.merged_at!).getTime() - new Date(a.merged_at!).getTime(),
    )
    .slice(0, PR_COUNT);

  const notes: PatchNote[] = merged.map((pr) => {
    const { title, category } = cleanTitle(pr.title);
    return {
      number: pr.number,
      title,
      raw_title: pr.title,
      summary: extractSummary(pr.body),
      merged_at: pr.merged_at!,
      author: pr.user?.login ?? "unknown",
      url: pr.html_url,
      category,
    };
  });

  const payload = {
    generated_at: new Date().toISOString(),
    repo: `${REPO_OWNER}/${REPO_NAME}`,
    notes,
  };
  await writeFile(outPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  console.log(`[patch-notes] wrote ${notes.length} entries to ${outPath}`);
}

main().catch((err) => {
  console.error("[patch-notes] refresh failed:", err);
  process.exit(1);
});
