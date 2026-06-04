// Phase 1.9.4 AI clerk — Claude summarizer.
//
// Takes the raw streaming transcript (text with [speaker N] markers) and
// returns a structured note set: title, attendees, decisions, action items,
// risks/blockers, next meeting. Output is markdown — the PDF renderer
// converts it to a styled document.
//
// Configuration:
//   ANTHROPIC_API_KEY  — required for real summarization
//   ANTHROPIC_MODEL    — optional; defaults to a recent Sonnet
//
// If ANTHROPIC_API_KEY is missing we return a best-effort placeholder so
// the rest of the pipeline (Synology upload, etc.) still runs end-to-end
// during testing.

import Anthropic from "@anthropic-ai/sdk";

export interface SummarizeOpts {
  transcript: string;
  attendees: Array<{ name: string; email?: string | null }>;
  channelName: string;
  contractTitle?: string | null;
  startedAt: Date;
  endedAt: Date;
}

export interface SummarizeResult {
  title: string;
  markdown: string;
  // True if Claude returned a real summary (vs. the local placeholder).
  ai: boolean;
}

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

export function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export async function summarizeMeeting(opts: SummarizeOpts): Promise<SummarizeResult> {
  const safeTranscript = (opts.transcript || "").trim();
  const fallbackTitle = opts.contractTitle
    ? `${opts.contractTitle} — meeting notes`
    : `${opts.channelName} — meeting notes`;

  if (!isAnthropicConfigured()) {
    return {
      title: fallbackTitle,
      ai: false,
      markdown: buildFallbackMarkdown(opts, safeTranscript),
    };
  }

  // Guard against absurd transcripts. Claude can take a lot, but trimming
  // protects us from runaway costs if a session somehow ran for days.
  const MAX_CHARS = 200_000;
  const trimmedTranscript = safeTranscript.length > MAX_CHARS
    ? safeTranscript.slice(-MAX_CHARS)
    : safeTranscript;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = (process.env.ANTHROPIC_MODEL || DEFAULT_MODEL).trim();

  const systemPrompt = `You are an experienced executive assistant taking minutes for a construction operations meeting.
You will receive a raw transcript with speaker labels like [speaker 0], [speaker 1] etc.
You will produce concise, structured notes in markdown for a written record that gets filed alongside contracts.

Requirements:
- Produce a short Title (one line, max ~80 chars) suitable as the filename for the notes.
- Identify attendees by matching speaker labels to the provided attendee list when possible; otherwise refer to them as "Speaker 1", "Speaker 2", etc.
- Capture the key points discussed, decisions made, action items (with owner + due date when stated), risks/blockers, and any next-meeting items.
- Be factual and conservative — do not invent commitments or names that aren't in the transcript.
- If the transcript is very short or unclear, say so plainly rather than padding.

Return your response as a single JSON object with two fields:
  {
    "title": "...",
    "markdown": "..."
  }
The markdown field must contain the meeting notes as markdown (no surrounding code fences).`;

  const userPrompt = [
    `Channel: ${opts.channelName}`,
    opts.contractTitle ? `Linked contract: ${opts.contractTitle}` : null,
    `Start: ${opts.startedAt.toISOString()}`,
    `End: ${opts.endedAt.toISOString()}`,
    `Duration: ${Math.max(0, Math.round((opts.endedAt.getTime() - opts.startedAt.getTime()) / 1000))}s`,
    "",
    `Attendees on the call:`,
    ...opts.attendees.map(a => `- ${a.name}${a.email ? ` <${a.email}>` : ""}`),
    "",
    `Transcript:`,
    "```",
    trimmedTranscript || "(no speech captured)",
    "```",
  ].filter(Boolean).join("\n");

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const text = response.content
      .filter(b => b.type === "text")
      .map(b => (b as any).text as string)
      .join("");
    const parsed = extractJson(text);
    if (parsed && typeof parsed.title === "string" && typeof parsed.markdown === "string") {
      return { title: parsed.title.trim() || fallbackTitle, markdown: parsed.markdown.trim(), ai: true };
    }
    // Claude didn't return clean JSON — wrap the raw text as a best-effort note.
    return {
      title: fallbackTitle,
      ai: true,
      markdown: text.trim() || buildFallbackMarkdown(opts, safeTranscript),
    };
  } catch (err) {
    console.warn("[meeting-clerk] anthropic summarize failed:", (err as Error).message);
    return {
      title: fallbackTitle,
      ai: false,
      markdown: buildFallbackMarkdown(opts, safeTranscript),
    };
  }
}

function extractJson(text: string): { title?: unknown; markdown?: unknown } | null {
  // Try a direct parse, then look for the first balanced {...} block.
  const direct = tryParse(text);
  if (direct) return direct;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(text.slice(start, end + 1));
  return null;
}
function tryParse(t: string): any | null { try { return JSON.parse(t); } catch { return null; } }

function buildFallbackMarkdown(opts: SummarizeOpts, transcript: string): string {
  const lines = [
    `# Meeting notes — ${opts.channelName}`,
    "",
    opts.contractTitle ? `**Linked contract:** ${opts.contractTitle}` : "",
    `**Start:** ${opts.startedAt.toLocaleString()}`,
    `**End:** ${opts.endedAt.toLocaleString()}`,
    `**Duration:** ${Math.max(0, Math.round((opts.endedAt.getTime() - opts.startedAt.getTime()) / 1000))}s`,
    "",
    `## Attendees`,
    ...opts.attendees.map(a => `- ${a.name}${a.email ? ` (${a.email})` : ""}`),
    "",
    `## Notes`,
    `AI summarization unavailable (no ANTHROPIC_API_KEY). Raw transcript included below.`,
    "",
    `## Transcript`,
    "```",
    transcript || "(no speech captured)",
    "```",
  ];
  return lines.filter(l => l !== "").join("\n");
}
