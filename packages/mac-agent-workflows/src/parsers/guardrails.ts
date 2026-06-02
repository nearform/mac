/**
 * Pure parser for the guardrails agent's `GUARDRAILS: READY|BLOCKED` output
 * contract. The build workflow parses this marker to decide whether to gate
 * (see the app build workflow), so it is a hard contract.
 */
export function parseGuardrails(text: string): {
  ready: boolean;
  report: string;
} {
  const trimmed = text.trimStart();
  const m = trimmed.match(/^GUARDRAILS:\s*(READY|BLOCKED)\s*\n?/i);
  if (!m) return { ready: false, report: text.trim() };
  return { ready: m[1]!.toUpperCase() === "READY", report: trimmed.slice(m[0].length).trim() };
}
