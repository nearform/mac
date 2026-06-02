/**
 * Classifier contract (types only — no LLM code).
 *
 * The host dispatch classifies ambiguous human text (GitHub comments with a
 * maintainer mention, Slack messages) into one of the assembled
 * `MacClassifierIntent` ids. The classification is an LLM call that reads
 * provider keys, so the *implementation* must not live in `/core` — core
 * defines only the shape. The default implementation (`createLlmClassifier`)
 * lives in the preset layer (`@nearform/mac`); an app may inject its own via
 * `MacRoutingConfig.classifier.classify`.
 *
 * Phase 11 (dispatch/router migration) replaced the old closed `CommentIntent`
 * enum + `ClassifyFn`/`ScreenFn` seams with this data-driven contract: the set
 * of intents is the merged `MacClassifierIntent[]` catalogue, not a hardcoded
 * union.
 */

/** Optional surrounding context for a classification. */
export interface ClassifierContext {
  /** Title of the issue/PR the comment is on (when applicable). */
  issueTitle?: string;
  /** True when the comment is on a PR rather than an issue. */
  isPullRequest?: boolean;
}

/**
 * The classifier's verdict: which intent (by id) the text matched, any repo /
 * issue reference it extracted, and the injection screener's advisory flag.
 */
export interface MacClassification {
  /** The matched intent id (matches a `MacClassifierIntent.id`), or null → no intent. */
  intentId: string | null;
  /** Repository mentioned in the text, if any (always "owner/name"). */
  repo?: string;
  /** Issue or PR number mentioned, if any. */
  issueNumber?: number;
  /** Reason given (e.g. for a reject-style intent). */
  reason?: string;
  /** Injection screener flagged the text as a likely prompt-injection attempt. */
  flagged?: boolean;
  /** Short reason from the injection screener, if flagged. */
  flagReason?: string;
}

/** Classify free-form human text into an intent id (+ repo/issue extraction + screen). */
export interface MacClassifier {
  classify(text: string, ctx?: ClassifierContext): Promise<MacClassification>;
}
