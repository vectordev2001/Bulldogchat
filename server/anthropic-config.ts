// Centralized resolution of Anthropic API key + model. Both helpers are pure
// reads from process.env so they pick up changes between requests without
// requiring a server restart, and they NEVER throw — a misconfigured model
// or absent key downgrades to a safe default + recorded reason instead of
// crashing request handling.

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

// Known-good model identifiers and short aliases. Aliases resolve to a
// concrete dated model so that a typo like "claude-sonnet-4-6" (without the
// date suffix) doesn't silently become a 404 from the Anthropic API at
// request time. Update this list when a new model rolls out — anything not
// in the list is still allowed through (Anthropic adds models faster than
// we redeploy), but it gets a one-time warning so operators notice.
const KNOWN_MODELS: Record<string, string> = {
  // Haiku 4.5
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  // Sonnet 4.5 / 4.6
  "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-5-20250929": "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  // Opus 4.6 / 4.7
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-opus-4-7": "claude-opus-4-7",
};

const warnedModels = new Set<string>();

function looksLikeAnthropicModel(value: string): boolean {
  // Anthropic model ids are prefixed with "claude-". Anything else is
  // almost certainly a misconfiguration (e.g. a paste of an OpenAI model
  // id, an empty-string placeholder, or "default").
  return /^claude-[a-z0-9._-]+$/i.test(value);
}

export interface ResolvedModel {
  model: string;
  source: "env" | "alias" | "default";
  warning?: string;
}

export function resolveAnthropicModel(): ResolvedModel {
  const raw = (process.env.ANTHROPIC_MODEL || "").trim();
  if (!raw) {
    return { model: DEFAULT_ANTHROPIC_MODEL, source: "default" };
  }
  if (!looksLikeAnthropicModel(raw)) {
    if (!warnedModels.has(raw)) {
      warnedModels.add(raw);
      // eslint-disable-next-line no-console
      console.warn(
        `[anthropic] ANTHROPIC_MODEL=${JSON.stringify(raw)} does not look like an Anthropic model id; falling back to ${DEFAULT_ANTHROPIC_MODEL}.`,
      );
    }
    return {
      model: DEFAULT_ANTHROPIC_MODEL,
      source: "default",
      warning: `Invalid ANTHROPIC_MODEL=${raw}; using ${DEFAULT_ANTHROPIC_MODEL}.`,
    };
  }
  const aliased = KNOWN_MODELS[raw];
  if (aliased) {
    return {
      model: aliased,
      source: aliased === raw ? "env" : "alias",
    };
  }
  // Unknown model id but well-formed. Allow it through but warn once so an
  // operator notices if it turns out to 404 against the Anthropic API.
  if (!warnedModels.has(raw)) {
    warnedModels.add(raw);
    // eslint-disable-next-line no-console
    console.warn(
      `[anthropic] ANTHROPIC_MODEL=${JSON.stringify(raw)} is not in the known model list; passing through to the API.`,
    );
  }
  return { model: raw, source: "env" };
}

export function resolveAnthropicApiKey(): string | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  return key ? key : null;
}

export function isAnthropicConfigured(): boolean {
  return resolveAnthropicApiKey() !== null;
}
