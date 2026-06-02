/**
 * The default data-driven LLM classifier (preset layer).
 *
 * Unlike the legacy classifier — which hardcoded a closed `CommentIntent` enum
 * and a fixed prompt — this one assembles its prompt from the merged
 * `MacClassifierIntent[]` catalogue: each intent's `id`, `description`, and
 * `examples` become a category line. The set of routable intents is therefore
 * whatever the installed extensions + `routing.classifier.extraIntents`
 * contribute, with no enum to keep in sync.
 *
 * Env reads (provider keys) are confined to `./llm.ts` and `./screen.ts` — the
 * documented "no env in packages" exception for the classifier seam. This is
 * why the classifier lives in the preset root, not in `/core`.
 */
import type {
  MacClassifier,
  MacClassification,
  ClassifierContext,
  MacClassifierIntent,
} from "../../core/index.js";
import { callLlm as defaultCallLlm, defaultFastModel } from "./llm.js";
import { screenForInjection } from "./screen.js";

export type { ScreenResult } from "./screen.js";
export { screenForInjection, flagPrefix } from "./screen.js";
export { callLlm, defaultFastModel, resolveProvider } from "./llm.js";

export interface LlmClassifierConfig {
  /** Model id for the tiny classify/screen calls. Defaults to a fast model from env. */
  model?: string;
  /** The intent catalogue the prompt is assembled from. */
  intents: MacClassifierIntent[];
  /** Injectable LLM call (for testing). Defaults to the built-in `callLlm`. */
  callLlm?: typeof defaultCallLlm;
}

const BASE_TEMPLATE_HEAD = `You are a router for messages directed at a GitHub/Slack bot.
Classify the user's message into exactly one of the categories below, and
extract any repository or issue references.

Categories:`;

const BASE_TEMPLATE_TAIL = `When the message does not clearly match any category, respond with INTENT: NONE.
Prefer the conversational/default category over an action category when the
intent is ambiguous — only pick an action category when there is a clear action
verb or an unambiguous request.

Repo extraction: always emit REPO as "owner/name" (never a URL). If the message
contains a github.com URL, convert it: https://github.com/acme/widgets → acme/widgets.
URL paths like /issues/42 or /pull/5 should populate ISSUE as well.

When the message is a reply on an existing issue/PR, the issue title is provided
as ISSUE TITLE. Short imperative replies like "lets build this", "go ahead",
"ship it", "do it" take the issue itself as their implicit object.

Respond in exactly this format (each on its own line, no extra text):
INTENT: <ONE CATEGORY ID> or NONE
REPO: owner/name or NONE
ISSUE: number or NONE
REASON: text or NONE`;

/**
 * Assemble the classifier system prompt from the intent catalogue. Exported for
 * unit testing (catalogue → prompt contains each intent's description/examples).
 */
export function assembleClassifierPrompt(intents: MacClassifierIntent[]): string {
  const categories = intents
    .map((intent) => {
      const id = intent.id.toUpperCase();
      const examples =
        intent.examples && intent.examples.length > 0
          ? `\n  Examples: ${intent.examples.map((e) => JSON.stringify(e)).join(", ")}`
          : "";
      return `${id} — ${intent.description}${examples}`;
    })
    .join("\n");
  return `${BASE_TEMPLATE_HEAD}\n${categories}\n\n${BASE_TEMPLATE_TAIL}`;
}

/**
 * Extract owner/repo and optional issue/PR number from any github.com URL in
 * the text. Belt-and-suspenders for the LLM — if it forgets to normalize a URL
 * to owner/name, this fallback still recovers the repo.
 */
export function extractGithubRefFromText(
  text: string,
): { repo: string; issueNumber?: number } | undefined {
  const withNumber = text.match(
    /github\.com\/([\w-]+)\/([\w.-]+?)\/(?:issues|pull)\/(\d+)\b/i,
  );
  if (withNumber) {
    return {
      repo: `${withNumber[1]}/${cleanRepoName(withNumber[2]!)}`,
      issueNumber: parseInt(withNumber[3]!, 10),
    };
  }
  const bare = text.match(/github\.com\/([\w-]+)\/([\w.-]+?)(?=[\s/?#,]|$)/i);
  if (bare) {
    return { repo: `${bare[1]}/${cleanRepoName(bare[2]!)}` };
  }
  return undefined;
}

function cleanRepoName(name: string): string {
  return name.replace(/[.,]+$/, "").replace(/\.git$/i, "");
}

/**
 * Build a default LLM classifier from an intent catalogue. The returned
 * classifier runs the intent classification and the injection screen in
 * parallel and folds both into one `MacClassification`.
 */
export function createLlmClassifier(config: LlmClassifierConfig): MacClassifier {
  const systemPrompt = assembleClassifierPrompt(config.intents);
  const call = config.callLlm ?? defaultCallLlm;
  // id (uppercased) → canonical id, for mapping the LLM's INTENT line back.
  const idByUpper = new Map(config.intents.map((i) => [i.id.toUpperCase(), i.id]));

  return {
    async classify(text: string, ctx?: ClassifierContext): Promise<MacClassification> {
      const [intentPart, screen] = await Promise.all([
        classifyIntent(text, ctx, systemPrompt, idByUpper, call, config.model),
        screenForInjection(text, config.model),
      ]);
      return { ...intentPart, flagged: screen.flagged, flagReason: screen.reason };
    },
  };
}

async function classifyIntent(
  text: string,
  ctx: ClassifierContext | undefined,
  systemPrompt: string,
  idByUpper: Map<string, string>,
  call: typeof defaultCallLlm,
  model?: string,
): Promise<Pick<MacClassification, "intentId" | "repo" | "issueNumber" | "reason">> {
  try {
    const userPrompt = ctx?.issueTitle
      ? `Classify this comment (replying on an existing ${ctx.isPullRequest ? "PR" : "issue"}):\n\nISSUE TITLE: ${ctx.issueTitle}\n\nCOMMENT: ${text}`
      : `Classify this message:\n\n${text}`;

    const output = await call(
      model || defaultFastModel("classifier"),
      systemPrompt,
      userPrompt,
      { maxTokens: 128 },
    );

    const intentMatch = output.toUpperCase().match(/INTENT:\s*([\w-]+)/);
    const token = intentMatch?.[1];
    const intentId = token && token !== "NONE" ? idByUpper.get(token) ?? null : null;

    const repoMatch = output.match(/REPO:\s*([\w-]+\/[\w.-]+)/i);
    const issueMatch = output.match(/ISSUE:\s*(\d+)/i);
    let repo = repoMatch?.[1];
    let issueNumber = issueMatch ? parseInt(issueMatch[1]!, 10) : undefined;
    if (!repo) {
      const fallback = extractGithubRefFromText(text);
      if (fallback) {
        repo = fallback.repo;
        if (issueNumber === undefined && fallback.issueNumber !== undefined) {
          issueNumber = fallback.issueNumber;
        }
      }
    }

    const reasonMatch = output.match(/REASON:\s*(.+)/i);
    const reason =
      reasonMatch && reasonMatch[1]!.trim().toUpperCase() !== "NONE"
        ? reasonMatch[1]!.trim()
        : undefined;

    return { intentId, repo, issueNumber, reason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[classifier] Error classifying message: ${message}`);
    return { intentId: null };
  }
}
