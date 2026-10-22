/**
 * Shared analysis and truncation detection utilities for IncidentLens.
 *
 * This module is intentionally decoupled from Cloudflare Workers runtime APIs,
 * Agent classes, and JSX so it can be safely imported by server code, client UI,
 * and offline Node.js test runners.
 */

export interface AnalysisMessageLike {
  role?: string;
  metadata?: unknown;
  parts?: Array<{ type?: string; text?: string; state?: string }>;
  content?: string;
}

export const REQUIRED_REPORT_SECTIONS = [
  "Incident Summary & Confirmed Facts",
  "Ranked Root-Cause Hypotheses",
  "Prioritized Diagnostic Next Steps"
] as const;

/**
 * Common trailing connective words that indicate a sentence or clause was abruptly
 * interrupted mid-generation (e.g., at an output token limit).
 */
const DANGLING_CONNECTIVE_PATTERN =
  /\b(?:the|a|an|and|or|but|for|with|by|from|to|in|on|at|of|that|which|because|if|when|while|is|are|was|were)\s*$/i;

export const CHAT_LIMITS = {
  FOLLOW_UP_MAX_LENGTH: 2000
} as const;

/**
 * Extracts plain text from a message object, handling both AI SDK parts and content strings.
 */
export function extractMessageText(message?: AnalysisMessageLike | null): string {
  if (!message) return "";
  if (message.parts && Array.isArray(message.parts)) {
    return message.parts
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n");
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return "";
}

/**
 * Validates conversational follow-up questions.
 * Enforces a strict 2,000-character upper bound while exempting initial structured
 * incident analysis submissions (which have separate, larger section budgets).
 */
export function validateFollowUpMessage(
  text: string
): { valid: true } | { valid: false; error: string } {
  // Structured incident submissions carry their own explicit validation contract
  if (text.includes("=== BEGIN UNTRUSTED INCIDENT DATA ===")) {
    return { valid: true };
  }
  const length = text.length;
  if (length > CHAT_LIMITS.FOLLOW_UP_MAX_LENGTH) {
    return {
      valid: false,
      error: `Follow-up message exceeds maximum length of ${CHAT_LIMITS.FOLLOW_UP_MAX_LENGTH} characters (got ${length}). Please shorten your question.`
    };
  }
  return { valid: true };
}

/**
 * Evaluates whether an assistant message was truncated by output limits or ended prematurely.
 *
 * Evaluation order:
 * 1. Non-assistant messages are ignored (returns false).
 * 2. Authoritative metadata: explicit `finishReason === "length"` or `truncated === true`
 *    takes precedence over all structural content (even if all section headings are present).
 * 3. Structural fallback: when authoritative metadata is absent, verifies that an incident
 *    investigation report contains all required sections and does not exhibit obvious
 *    premature termination.
 *
 * Known fallback limitations:
 * - Structural analysis cannot detect when a model stops cleanly after a complete sentence
 *   or bullet point while omitting subsequent planned steps, unless finishReason metadata is present.
 * - Non-standard report formats that do not use the expected section headings will not trigger
 *   the section-based structural checks.
 */
export function isAnalysisTruncated(message?: AnalysisMessageLike | null): boolean {
  if (!message || (message.role && message.role !== "assistant")) {
    return false;
  }

  // 1. Authoritative metadata check (must remain authoritative)
  if (message.metadata && typeof message.metadata === "object") {
    const meta = message.metadata as Record<string, unknown>;
    if (meta.finishReason === "length" || meta.truncated === true) {
      return true;
    }
    // Terminal failure states (errors, aborts, cancellations) are distinct from token-limit truncation
    if (
      meta.finishReason === "error" ||
      meta.finishReason === "abort" ||
      meta.finishReason === "cancelled"
    ) {
      return false;
    }
  }

  // 2. In-progress check: When authoritative metadata is absent, never classify an active
  // in-flight message as truncated via structural fallback while any part is actively streaming
  if (
    message.parts &&
    Array.isArray(message.parts) &&
    message.parts.some(
      (p) => p && typeof p === "object" && (p as { state?: string }).state === "streaming"
    )
  ) {
    return false;
  }

  // 2. Extract full text from message parts or content string
  const fullText = extractMessageText(message);
  const trimmed = fullText.trim();
  if (!trimmed) {
    return false;
  }

  // 3. Structural fallback: Only evaluate messages that represent an incident report
  // (unrelated conversational or assistant messages must not be classified as truncated)
  if (!/Incident Summary/i.test(trimmed)) {
    return false;
  }

  // Check 3a: Report stops before Section 3
  const section3Match = trimmed.match(/Prioritized Diagnostic Next Steps/i);
  if (!section3Match || section3Match.index === undefined) {
    return true;
  }

  // Check 3b: Section 3 heading exists but has no meaningful diagnostic content beneath it
  const section3Body = trimmed.slice(section3Match.index + section3Match[0].length).trim();
  const substantiveChars = section3Body.replace(/[^a-zA-Z0-9]/g, "");
  if (substantiveChars.length < 5) {
    return true;
  }

  // Check 3c: Obvious unfinished terminal content within Section 3
  const lastLine = trimmed.split("\n").filter((line) => line.trim().length > 0).pop() || "";
  const trimmedLastLine = lastLine.trim();

  // (i) Dangling list marker with no text (e.g., ends with "1." or "-")
  if (/^(?:[-*+]|\d+\.)\s*$/.test(trimmedLastLine)) {
    return true;
  }

  // (ii) Dangling connective words at the end (e.g., "...by querying Prometheus for")
  if (DANGLING_CONNECTIVE_PATTERN.test(trimmedLastLine)) {
    return true;
  }

  // (iii) Unclosed code block or inline backticks (odd number of backticks in message)
  const backtickCount = (trimmed.match(/`/g) || []).length;
  if (backtickCount % 2 !== 0) {
    return true;
  }

  // (iv) Unclosed parenthesis or bracket on the final line
  const openParen = (trimmedLastLine.match(/\(/g) || []).length;
  const closeParen = (trimmedLastLine.match(/\)/g) || []).length;
  if (openParen > closeParen) {
    return true;
  }

  const openBracket = (trimmedLastLine.match(/\[/g) || []).length;
  const closeBracket = (trimmedLastLine.match(/\]/g) || []).length;
  if (openBracket > closeBracket) {
    return true;
  }

  // (v) Trailing punctuation that requires continuation (dangling comma)
  if (/,\s*$/.test(trimmedLastLine)) {
    return true;
  }

  return false;
}
