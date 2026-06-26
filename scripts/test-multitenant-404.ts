/**
 * Cross-tenant 404 acceptance test for Bulldogchat multitenant gating.
 *
 * Uses the suite_internal_secret to mint a JWT-equivalent session for a
 * region-scoped user, then verifies that requests for channels / projects /
 * messages owned by OTHER regions return 404 (deny-by-default).
 *
 * Run against a deployed chat server (default https://chat.bulldogops.com)
 * or override with CHAT_URL.  Requires SUITE_INTERNAL_SECRET in env.
 */

import "dotenv/config";

const CHAT_URL = (process.env.CHAT_URL || "https://chat.bulldogops.com").replace(/\/$/, "");
const AUTH_URL = (process.env.BULLDOG_AUTH_URL || "https://auth.bulldogops.com").replace(/\/$/, "");
const SUITE_SECRET = process.env.SUITE_INTERNAL_SECRET || "";

if (!SUITE_SECRET) {
  console.error("Missing SUITE_INTERNAL_SECRET in env — set it before running.");
  process.exit(2);
}

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: CaseResult[] = [];

function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? " — " + detail : ""}`);
}

async function mintToken(email: string, grants: Array<{ companyId: string; locationId: string | null }>) {
  // Use auth's internal endpoint to mint a test token for the given email + grants.
  // bulldog-auth exposes POST /api/internal/test-token (shared-secret) for exactly this.
  const r = await fetch(`${AUTH_URL}/api/internal/test-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-suite-secret": SUITE_SECRET },
    body: JSON.stringify({ email, grants }),
  });
  if (!r.ok) {
    throw new Error(`mint token failed: ${r.status} ${await r.text()}`);
  }
  const j = await r.json();
  return j.token as string;
}

async function chatGet(token: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${CHAT_URL}${path}`, {
    headers: { Cookie: `bulldog_access=${token}` },
  });
  let body: any = null;
  try { body = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body };
}

async function main() {
  console.log(`Chat URL : ${CHAT_URL}`);
  console.log(`Auth URL : ${AUTH_URL}`);
  console.log("");

  // Pull projects (auth companies) + regions from chat as super-admin to know the topology.
  // Super admin token: jbieler@vectorfd.com with global super_admin role.
  let superToken: string;
  try {
    superToken = await mintToken("jbieler@vectorfd.com", []);
  } catch (e) {
    console.error("Cannot mint super-admin token — does bulldog-auth expose /api/internal/test-token?", e);
    process.exit(3);
  }

  const projects = await chatGet(superToken, "/api/projects");
  if (projects.status !== 200) {
    console.error("super admin GET /api/projects failed", projects.status, projects.body);
    process.exit(4);
  }
  const projectList: Array<{ id: number; name: string; authCompanyId?: string }> = projects.body;
  if (!Array.isArray(projectList) || projectList.length < 2) {
    console.error("Need >= 2 projects (auth companies) to run cross-tenant tests; got", projectList);
    process.exit(5);
  }

  // Pick two distinct projects.
  const projA = projectList[0];
  const projB = projectList[1];
  console.log(`Project A: ${projA.id} ${projA.name} (auth ${projA.authCompanyId})`);
  console.log(`Project B: ${projB.id} ${projB.name} (auth ${projB.authCompanyId})`);

  const regionsA = await chatGet(superToken, `/api/projects/${projA.id}/regions`);
  const regionsB = await chatGet(superToken, `/api/projects/${projB.id}/regions`);
  if (regionsA.status !== 200 || regionsB.status !== 200) {
    console.error("regions fetch failed", regionsA, regionsB);
    process.exit(6);
  }
  const regA0 = regionsA.body[0];
  const regB0 = regionsB.body[0];
  console.log(`Region A0: ${regA0.id} ${regA0.code} (authLoc ${regA0.authLocationId})`);
  console.log(`Region B0: ${regB0.id} ${regB0.code} (authLoc ${regB0.authLocationId})`);

  // Channels per project (super admin sees all).
  const chansA = await chatGet(superToken, `/api/projects/${projA.id}/channels`);
  const chansB = await chatGet(superToken, `/api/projects/${projB.id}/channels`);
  const chanInA = (chansA.body as any[]).find((c) => c.regionId === regA0.id) || (chansA.body as any[])[0];
  const chanInB = (chansB.body as any[]).find((c) => c.regionId === regB0.id) || (chansB.body as any[])[0];
  if (!chanInA || !chanInB) {
    console.error("could not pick channels in A and B", chansA.body, chansB.body);
    process.exit(7);
  }

  // Build a region-scoped grant: user only has access to projA + regionA0.
  const regionScopedEmail = `test-mt-${Date.now()}@bulldogops.test`;
  // Provision the user first via auth internal API (best-effort; the chat bridge
  // also auto-provisions on first hit).  Then mint a token with a narrow grant.
  // Use the AUTH-side ids (authCompanyId + authLocationId) so resolveGrants
  // on the chat side can map back to (projectId, regionId).
  const grants = [{ companyId: projA.authCompanyId!, locationId: regA0.authLocationId! }];
  const scopedToken = await mintToken(regionScopedEmail, grants);

  // ===== Cases =====
  const ownChan = await chatGet(scopedToken, `/api/channels/${chanInA.id}`);
  record("own-region channel returns 200", ownChan.status === 200, `status=${ownChan.status}`);

  const otherProjChan = await chatGet(scopedToken, `/api/channels/${chanInB.id}`);
  record("cross-project channel returns 404", otherProjChan.status === 404, `status=${otherProjChan.status}`);

  const otherProj = await chatGet(scopedToken, `/api/projects/${projB.id}`);
  record("cross-project project read returns 404", otherProj.status === 404, `status=${otherProj.status}`);

  const msgs = await chatGet(scopedToken, `/api/channels/${chanInB.id}/messages?limit=10`);
  record("cross-project messages list returns 404", msgs.status === 404, `status=${msgs.status}`);

  const listProj = await chatGet(scopedToken, `/api/projects`);
  const listIds = (Array.isArray(listProj.body) ? listProj.body : []).map((p: any) => p.id);
  record(
    "projects list does NOT include unauthorized project",
    listProj.status === 200 && listIds.includes(projA.id) && !listIds.includes(projB.id),
    `ids=${JSON.stringify(listIds)}`
  );

  const allChans = await chatGet(scopedToken, "/api/channels");
  const allChanIds = (Array.isArray(allChans.body) ? allChans.body : []).map((c: any) => c.id);
  record(
    "channels list does NOT include unauthorized channel",
    allChans.status === 200 && !allChanIds.includes(chanInB.id),
    `count=${allChanIds.length}, includesB=${allChanIds.includes(chanInB.id)}`
  );

  // ===== Summary =====
  const fail = results.filter((r) => !r.ok);
  console.log("");
  console.log(`Total: ${results.length}, passed: ${results.length - fail.length}, failed: ${fail.length}`);
  if (fail.length) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Test run errored:", e);
  process.exit(1);
});
