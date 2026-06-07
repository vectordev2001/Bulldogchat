// Seed the demo Vector Services organization with realistic data.
// Runs only when there are zero organizations in the database.

import { storage } from "./storage";
import { hashPassword } from "./auth";
import type { User, UserRole } from "@shared/schema";

interface SeedMember {
  email: string;
  name: string;
  initials: string;
  role: UserRole;
  title: string;
  hue: number;
}

const SEED_USERS: SeedMember[] = [
  { email: "chat@bulldogops.com",          name: "Jordan Bieler",   initials: "JB", role: "admin",   title: "Operations Lead",     hue: 2   },
  { email: "marcus@vectorservicesus.com",  name: "Marcus Caldera",  initials: "MC", role: "manager", title: "Day Foreman A",       hue: 232 },
  { email: "reina@vectorservicesus.com",   name: "Reina Tanaka",    initials: "RT", role: "manager",  title: "Estimator",           hue: 218 },
  { email: "devon@vectorservicesus.com",   name: "Devon Hollis",    initials: "DH", role: "manager", title: "Day Foreman B",       hue: 207 },
  { email: "kai@vectorservicesus.com",     name: "Kai Okafor",      initials: "KO", role: "user",     title: "Lineman II",          hue: 204 },
  { email: "sasha@vectorservicesus.com",   name: "Sasha Petrov",    initials: "SP", role: "user",     title: "Lineman I",           hue: 28  },
  { email: "lena@vectorservicesus.com",    name: "Lena Greer",      initials: "LG", role: "user"  ,  title: "Safety Officer",      hue: 2   },
  { email: "eli@vectorservicesus.com",     name: "Eli Vance",       initials: "EV", role: "user",     title: "Equipment Operator",  hue: 204 },
  { email: "aubrey@vectorservicesus.com",  name: "Aubrey Nguyen",   initials: "AN", role: "manager",  title: "Project Coordinator", hue: 218 },
  { email: "riley@vectorservicesus.com",   name: "Riley Kowalski",  initials: "RK", role: "user",     title: "Apprentice",          hue: 204 },
  { email: "tomas@vectorservicesus.com",   name: "Tomás Delgado",   initials: "TD", role: "manager", title: "Night Foreman",       hue: 232 },
  { email: "bryn@vectorservicesus.com",    name: "Bryn Mathis",     initials: "BM", role: "manager",  title: "AP / Billing",        hue: 28  },
  { email: "casey@vectorservicesus.com",   name: "Casey Whitaker",  initials: "CW", role: "user",     title: "Lineman III",         hue: 207 },
  { email: "hank@vectorservicesus.com",    name: "Hank Pellegrino", initials: "HP", role: "manager", title: "Foreman C",           hue: 232 },
  { email: "imani@vectorservicesus.com",   name: "Imani Brooks",    initials: "IB", role: "admin",   title: "Operations Manager",  hue: 2   },
];

const SEED_PROJECTS = [
  { slug: "lakewood-substation", name: "Lakewood Substation Rebuild",   short: "LSR", hue: 232, description: "Full rebuild of the 115/12.5kV substation for PSE." },
  { slug: "i-405-fiber",         name: "I-405 Fiber Pull",                short: "I-4", hue: 218, description: "Splice and pull single-mode fiber along I-405 corridor." },
  { slug: "bothell-poles",       name: "Bothell Pole Replacement",        short: "BPR", hue: 207, description: "Night-shift replacement of 14 poles for SnoPUD." },
  { slug: "redmond-switchgear",  name: "Redmond Switchgear Install",      short: "RSI", hue: 28,  description: "Switchgear cutover, 24/7 standby." },
  { slug: "snoqualmie-trench",   name: "Snoqualmie Trenching",            short: "SNQ", hue: 204, description: "Underground service trench and conduit installation." },
  { slug: "training-safety",     name: "Crew Training & Safety",          short: "C&S", hue: 2,   description: "Company-wide training, JHAs, refresher courses." },
  { slug: "equipment-fleet",     name: "Equipment & Fleet",               short: "FLT", hue: 28,  description: "Trucks, cranes, hydrovacs — schedules, repairs, fuel." },
  { slug: "hq-all-hands",        name: "HQ All-Hands",                    short: "HQ",  hue: 232, description: "Company-wide announcements and discussion." },
];

const TEXT_CHANNELS = [
  { name: "general",       topic: "General project chatter — keep it civil, keep it brief." },
  { name: "announcements", topic: "Read-only-ish. Drops from Ops and Safety. Pin important items." },
  { name: "field-ops",     topic: "Day-of crew updates: locates, equipment, weather calls." },
  { name: "safety",        topic: "PPE checks, incident reports, OSHA notes. No memes." },
  { name: "estimates",     topic: "Bid sheets, takeoffs, vendor quotes. Office only." },
  { name: "crew-schedule", topic: "Tomorrow's shift, who's on what truck, callouts." },
];
const VOICE_CHANNELS = ["Daily Standup", "Foreman Huddle", "Office", "War Room"];

// Generic seed messages for non-Lakewood projects (~10 per text channel)
function generic(channelName: string) {
  return [
    { e: "chat@bulldogops.com",   c: `Spinning up #${channelName} for this project. Drop questions, photos, and updates here.`, pin: true },
    { e: "reina@vectorservicesus.com",   c: `Office sweeps this channel daily — tag @reina for billing or scope questions.` },
    { e: "lena@vectorservicesus.com",    c: `Safety check-ins go here too. Photos welcome — bonus points if you're in PPE.` },
    { e: "marcus@vectorservicesus.com",  c: `Foremen — tomorrow's plan goes in #crew-schedule, not here.` },
    { e: "kai@vectorservicesus.com",     c: `Got it — keeping #general for chatter.` },
    { e: "devon@vectorservicesus.com",   c: `Locates clear through Friday on this scope. We're good.` },
    { e: "sasha@vectorservicesus.com",   c: `Truck 4 needs the rear tail-light fixed before Monday rotation.` },
    { e: "eli@vectorservicesus.com",     c: `Confirmed — I'll swing by the shop this afternoon.` },
    { e: "aubrey@vectorservicesus.com",  c: `Permit packet uploaded to the project folder. Reach out if you can't find it.` },
    { e: "riley@vectorservicesus.com",   c: `Tailboard JHA signed and filed. Ready to roll in the AM.` },
  ];
}

interface SeedMessage { e: string; c: string; pin?: boolean; reactions?: { emoji: string; userEmails: string[] }[] }

// Lakewood — #general (rich, 22 messages)
const lakewoodGeneral: SeedMessage[] = [
  { e: "chat@bulldogops.com",   c: "Morning team. Lakewood substation rebuild kickoff is officially live. Foundation pour goes Thursday if weather holds.", pin: true, reactions: [{ emoji: "✅", userEmails: ["marcus@vectorservicesus.com","devon@vectorservicesus.com","reina@vectorservicesus.com","lena@vectorservicesus.com","kai@vectorservicesus.com"] }] },
  { e: "reina@vectorservicesus.com",   c: "Estimate is locked. Final number came in at $1.47M, 4% under the engineer's. Sending the GMP packet to PSE this morning.", reactions: [{ emoji: "🔥", userEmails: ["chat@bulldogops.com","marcus@vectorservicesus.com"] }] },
  { e: "marcus@vectorservicesus.com",  c: "Crew A rolling out of the yard at 06:30. Three bucket trucks, the digger derrick, and the 40-ton crane on the lowboy. Locates are clear through Friday." },
  { e: "lena@vectorservicesus.com",    c: "Reminder: arc-flash cat 2 minimum once we're inside the fence. Hot stick checks before you touch anything energized. Logged 3 near-misses on the I-405 job last week — don't make me write a fourth.", reactions: [{ emoji: "✅", userEmails: ["marcus@vectorservicesus.com","devon@vectorservicesus.com","kai@vectorservicesus.com","sasha@vectorservicesus.com","eli@vectorservicesus.com","riley@vectorservicesus.com"] }] },
  { e: "devon@vectorservicesus.com",   c: "Transformer delivery from ABB pushed to Wednesday. Their flatbed lost a tire outside Spokane. New ETA 14:00." },
  { e: "reina@vectorservicesus.com",   c: "Already on it — I told them we eat the demurrage if it slips past Thursday morning. They'll be motivated." },
  { e: "kai@vectorservicesus.com",     c: "Pulled the cable schedule. We're short ~340ft of 750 MCM on the secondary side. Can someone in the office cut a PO?" },
  { e: "aubrey@vectorservicesus.com",  c: "On it Kai. WESCO has stock in Kent. Will-call by 11:00 if Devon can swing the F-450 by.", reactions: [{ emoji: "🙏", userEmails: ["kai@vectorservicesus.com"] }] },
  { e: "devon@vectorservicesus.com",   c: "Copy. Sending Riley." },
  { e: "marcus@vectorservicesus.com",  c: "Heads up — KING5 just rolled a news van past the fence. Probably nothing but PR wanted me to flag it." },
  { e: "chat@bulldogops.com",   c: "I'll call their assignment desk. Nobody talks on camera without me. Reina, can you draft a one-paragraph statement just in case?" },
  { e: "reina@vectorservicesus.com",   c: "Drafting now. Will drop in #announcements." },
  { e: "sasha@vectorservicesus.com",   c: "Photo from inside the fence — the old switchgear is uglier than the survey showed. Lot of corrosion on the B-phase bushings." },
  { e: "eli@vectorservicesus.com",     c: "I can torch them off but we'll need replacement bushings on the BOM. Adding to the change-order list." },
  { e: "lena@vectorservicesus.com",    c: "If you're torching, full FR layers, fire watch posted, extinguisher within 10ft. Confirm before you light up.", reactions: [{ emoji: "✅", userEmails: ["eli@vectorservicesus.com","marcus@vectorservicesus.com"] }] },
  { e: "marcus@vectorservicesus.com",  c: "Confirmed. Eli's got it." },
  { e: "tomas@vectorservicesus.com",   c: "Night shift will swap the breaker compartments 22:00 → 04:00. Traffic control approved by Lakewood PD. We're good to roll." },
  { e: "bryn@vectorservicesus.com",    c: "Heads up — billable hours for Lakewood need to hit the timesheet by Friday 17:00 or AP will hold the invoice another two weeks. Don't make me chase." },
  { e: "kai@vectorservicesus.com",     c: "Lunch run — anyone want from Taqueria El Asadero? Cash app only, no cards.", reactions: [{ emoji: "🌮", userEmails: ["riley@vectorservicesus.com","sasha@vectorservicesus.com","eli@vectorservicesus.com"] }] },
  { e: "riley@vectorservicesus.com",   c: "Two carne asada burritos and a Jarritos lime" },
  { e: "sasha@vectorservicesus.com",   c: "Same but al pastor 🌮" },
  { e: "chat@bulldogops.com",   c: "Field-ops sync at 14:00 in War Room voice. Foremen + Reina + Lena. Will be quick.", reactions: [{ emoji: "✅", userEmails: ["marcus@vectorservicesus.com","devon@vectorservicesus.com","reina@vectorservicesus.com","lena@vectorservicesus.com"] }] },
];

const lakewoodAnnouncements: SeedMessage[] = [
  { e: "chat@bulldogops.com", c: "**Project kickoff — Lakewood Substation Rebuild**\n\nScope: full rebuild of the 115/12.5kV substation including replacement of two 30 MVA transformers, switchgear, breakers, and protective relaying. Owner: PSE. Duration: 14 weeks.\n\nForemen: Marcus (day), Tomás (night). Estimator of record: Reina.\n\nPlease keep #general for chatter. This channel is for ops-level announcements only.", pin: true },
  { e: "lena@vectorservicesus.com",  c: "**Safety stand-down completed.** All 18 crew members signed the Lakewood-specific JHA. Forms filed at HQ. Next refresher 14 days from today." },
  { e: "reina@vectorservicesus.com", c: "Press response (draft) for media inquiries:\n\n> Vector Services is partnering with Puget Sound Energy to modernize the Lakewood substation, improving grid resilience for over 14,000 residential and commercial customers." },
];

const lakewoodFieldOps: SeedMessage[] = [
  { e: "marcus@vectorservicesus.com", c: "Crew A on site, 06:34. Coffee on the tailgate. Tailgate JHA in 6 minutes." },
  { e: "devon@vectorservicesus.com",  c: "Crew B grabbing the will-call from WESCO Kent, then heading to the laydown yard. ETA Lakewood 10:15." },
  { e: "eli@vectorservicesus.com",    c: "Lowboy unloaded. Crane staged on the south pad. Outriggers chocked, matting under all four." },
  { e: "lena@vectorservicesus.com",   c: "Heat index hitting 91 by 14:00. Mandatory water breaks every 30 min after lunch. Pop-up shade at the gang box." },
  { e: "sasha@vectorservicesus.com",  c: "B-phase bushing pull complete. Old one's ugly — check the photo in #general. Saving the bus bars for inspection." },
  { e: "kai@vectorservicesus.com",    c: "Grounding mat installed at the work zone. Continuity tested, 0.12Ω to the master ground. Logged." },
  { e: "riley@vectorservicesus.com",  c: "WESCO will-call picked up. 380ft of 750 MCM on the truck. Heading back." },
  { e: "marcus@vectorservicesus.com", c: "Traffic control plan for tonight's outage is posted at the gate. Cones go out at 21:00, lane closure 22:00 to 04:00." },
  { e: "tomas@vectorservicesus.com",  c: "Confirming — I'll relieve Marcus at 18:00. Night crew of 6 plus a flagger pair." },
  { e: "devon@vectorservicesus.com",  c: "All five drops energized, primary side proven dead. Cleared to start the swap." },
];

const lakewoodSafety: SeedMessage[] = [
  { e: "lena@vectorservicesus.com",   c: "**JHA — Lakewood Substation Rebuild.**\nHazards: arc flash, fall (work platforms >6ft), pinch (crane lifts), heat. Controls: Cat 2 PPE inside the fence, 100% tie-off above 6ft, dedicated rigger + signaler on every pick, 30-min water breaks.", pin: true },
  { e: "lena@vectorservicesus.com",   c: "Reminder: hot stick test before every use. We've had three sticks fail the megger this quarter. If yours feels off, pull it from service." },
  { e: "marcus@vectorservicesus.com", c: "Crew A briefed and signed in. Pre-job huddle on video, posted to compliance folder." },
  { e: "lena@vectorservicesus.com",   c: "Near-miss logged from Bothell yesterday — apprentice climbed without secondary tie-off. Coaching delivered, no write-up. Don't repeat." },
  { e: "riley@vectorservicesus.com",  c: "That was me. Won't happen again. Apologies." },
  { e: "chat@bulldogops.com",  c: "Appreciate you owning it Riley. Lena, schedule him for the fall protection refresher this week." },
  { e: "lena@vectorservicesus.com",   c: "Done — Thursday 16:00, training trailer." },
  { e: "tomas@vectorservicesus.com",  c: "Night crew safety brief at 19:30 sharp. PPE check, radio check, lock-out review." },
  { e: "eli@vectorservicesus.com",    c: "Confirming the crane's annual inspection sticker is current — expires 9/2026. We're good." },
  { e: "lena@vectorservicesus.com",   c: "Reminder: incident reports go through me first. Don't post photos of injuries publicly. Privacy and liability." },
];

const MESSAGES_BY_PROJECT_CHANNEL: Record<string, Record<string, SeedMessage[]>> = {
  "lakewood-substation": {
    "general":       lakewoodGeneral,
    "announcements": lakewoodAnnouncements,
    "field-ops":     lakewoodFieldOps,
    "safety":        lakewoodSafety,
  },
};

export async function runSeed() {
  if (storage.orgCount() > 0) {
    return; // already seeded
  }

  console.log("[seed] No organizations found — seeding Vector Services demo data...");

  // 1. Create org
  const org = storage.createOrg({
    name: "Vector Services",
    slug: "vector-services",
    plan: "starter",
  });

  // 2. Create users
  const passwordHashAdmin = hashPassword("Vector2026!");
  const passwordHashCrew = hashPassword("Crew2026!");

  const usersByEmail = new Map<string, User>();
  for (const u of SEED_USERS) {
    const created = storage.createUser({
      orgId: org.id,
      email: u.email,
      passwordHash: u.email === "chat@bulldogops.com" ? passwordHashAdmin : passwordHashCrew,
      name: u.name,
      title: u.title,
      avatarUrl: null,
      hue: u.hue,
      role: u.role,
      status: "online",
    });
    usersByEmail.set(u.email, created);
  }

  const allUserIds = Array.from(usersByEmail.values()).map(u => u.id);

  // 3. Create projects + channels + messages
  for (const p of SEED_PROJECTS) {
    const project = storage.createProject({
      orgId: org.id,
      name: p.name,
      slug: p.slug,
      short: p.short,
      hue: p.hue,
      description: p.description,
    });
    // Add ALL users as members (single org, single team)
    for (const uid of allUserIds) {
      storage.addProjectMember(project.id, uid, "member");
    }

    // Create channels
    let pos = 0;
    for (const tc of TEXT_CHANNELS) {
      const ch = storage.createChannel({
        projectId: project.id,
        name: tc.name,
        type: "text",
        topic: tc.topic,
        position: pos++,
      });

      // Seed messages
      const projectMsgs = MESSAGES_BY_PROJECT_CHANNEL[p.slug]?.[tc.name];
      const msgs = projectMsgs ?? generic(tc.name);
      for (const m of msgs) {
        const author = usersByEmail.get(m.e);
        if (!author) continue;
        const created = storage.createMessage({
          channelId: ch.id,
          userId: author.id,
          content: m.c,
        });
        if (m.pin) storage.pinMessage(created.id, true);
        if (m.reactions) {
          for (const r of m.reactions) {
            for (const ue of r.userEmails) {
              const u = usersByEmail.get(ue);
              if (u) storage.addReaction(created.id, u.id, r.emoji);
            }
          }
        }
      }
    }
    for (const vname of VOICE_CHANNELS) {
      storage.createChannel({
        projectId: project.id,
        name: vname,
        type: "voice",
        topic: null,
        position: pos++,
      });
    }
  }

  console.log(`[seed] Done. Admin login: chat@bulldogops.com / Vector2026!`);
}
