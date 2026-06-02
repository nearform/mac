/**
 * Pure parser for the reviewer agents' `VERDICT: X` output contract.
 *
 * The PR reviewer and build reviewer both begin their stdout with a line
 * `VERDICT: APPROVE | REQUEST_CHANGES | COMMENT`, followed by the markdown
 * review body. The workflow steps post the review deterministically from this
 * parsed result (see the app workflows), so the marker is a hard contract.
 */
export function parseVerdict(text: string): {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
} {
  const trimmed = text.trimStart();
  const m = trimmed.match(/^VERDICT:\s*(APPROVE|REQUEST_CHANGES|COMMENT)\s*\n?/i);
  if (!m) return { event: "COMMENT", body: text.trim() };
  const event = m[1]!.toUpperCase() as "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  return { event, body: trimmed.slice(m[0].length).trim() || "(no review body)" };
}
