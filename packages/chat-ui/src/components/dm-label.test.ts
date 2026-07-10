// Logic-only test for the DM display-label derivation used by DmSection's
// DmRow and mirrored in Home.tsx's dmDisplayLabel memo:
//   - a custom `title` (Titled Chats, Phase 2.5) always wins when present
//   - otherwise fall back to a comma-joined list of the other members' names
//   - a DM with zero "other" members (a self-DM) shows "Just you"
//
// NOTE: this repo has no client-side component-rendering test framework
// (no Vitest/jsdom/@testing-library in package.json or node_modules) — the
// only test runner in use repo-wide is Node's built-in `node:test`, and only
// for server-side integration tests. Rather than introduce a new test
// toolchain for a single component, this test extracts the pure label-
// derivation logic (identical to the inline logic in DmRow / Home.tsx) and
// exercises it directly. This is called out as a deviation in the PR body.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

interface MinimalUser {
  id: number;
  name: string;
}

interface MinimalDm {
  id: number;
  title: string | null;
  memberIds: number[];
}

// Mirrors DmRow's label derivation in client/src/components/DmSection.tsx
// and the dmDisplayLabel memo in client/src/pages/Home.tsx.
function deriveDmLabel(dm: MinimalDm, meId: number, userById: Map<number, MinimalUser>): string {
  const others = dm.memberIds.filter((id) => id !== meId);
  const otherUsers = others.map((id) => userById.get(id)).filter(Boolean) as MinimalUser[];
  const participantLabel = otherUsers.length === 0 ? "Just you" : otherUsers.map((u) => u.name).join(", ");
  return dm.title || participantLabel;
}

describe("deriveDmLabel (Titled Chats label priority)", () => {
  const me: MinimalUser = { id: 1, name: "Me" };
  const alice: MinimalUser = { id: 2, name: "Alice" };
  const bob: MinimalUser = { id: 3, name: "Bob" };
  const userById = new Map<number, MinimalUser>([
    [me.id, me],
    [alice.id, alice],
    [bob.id, bob],
  ]);

  test("custom title takes priority over participant names", () => {
    const dm: MinimalDm = { id: 10, title: "Q3 Planning", memberIds: [me.id, alice.id] };
    assert.equal(deriveDmLabel(dm, me.id, userById), "Q3 Planning");
  });

  test("falls back to single participant name when no title is set", () => {
    const dm: MinimalDm = { id: 11, title: null, memberIds: [me.id, alice.id] };
    assert.equal(deriveDmLabel(dm, me.id, userById), "Alice");
  });

  test("falls back to comma-joined participant names for group DMs", () => {
    const dm: MinimalDm = { id: 12, title: null, memberIds: [me.id, alice.id, bob.id] };
    assert.equal(deriveDmLabel(dm, me.id, userById), "Alice, Bob");
  });

  test("empty string title is treated as unset (falls back to participants)", () => {
    const dm: MinimalDm = { id: 13, title: "", memberIds: [me.id, alice.id] };
    assert.equal(deriveDmLabel(dm, me.id, userById), "Alice");
  });

  test("self-DM with no other members shows 'Just you' when untitled", () => {
    const dm: MinimalDm = { id: 14, title: null, memberIds: [me.id] };
    assert.equal(deriveDmLabel(dm, me.id, userById), "Just you");
  });

  test("self-DM with a title still shows the title", () => {
    const dm: MinimalDm = { id: 15, title: "Scratchpad", memberIds: [me.id] };
    assert.equal(deriveDmLabel(dm, me.id, userById), "Scratchpad");
  });

  test("a deactivated/missing member is silently dropped from the label", () => {
    const dm: MinimalDm = { id: 16, title: null, memberIds: [me.id, alice.id, 999] };
    assert.equal(deriveDmLabel(dm, me.id, userById), "Alice");
  });
});
