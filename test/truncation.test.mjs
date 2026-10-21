import test from "node:test";
import assert from "node:assert/strict";
import {
  isAnalysisTruncated,
  CHAT_LIMITS,
  extractMessageText,
  validateFollowUpMessage
} from "../src/analysis-utils.ts";

test("1. finishReason: 'length' is classified as truncated", () => {
  const msg = {
    role: "assistant",
    metadata: { finishReason: "length" },
    parts: [{ type: "text", text: "Partial report text" }]
  };
  assert.equal(isAnalysisTruncated(msg), true);
});

test("2. truncated: true metadata is classified as truncated", () => {
  const msg = {
    role: "assistant",
    metadata: { truncated: true },
    parts: [{ type: "text", text: "Partial report text" }]
  };
  assert.equal(isAnalysisTruncated(msg), true);
});

test("3. complete report with all three sections and meaningful diagnostic steps is not truncated", () => {
  const msg = {
    role: "assistant",
    metadata: { finishReason: "stop" },
    parts: [
      {
        type: "text",
        text: `## Incident Summary & Confirmed Facts
- Error rate on checkout spiked to 19.2% over 15 minutes.
- Upstream payment services are returning connection timeouts.

## Ranked Root-Cause Hypotheses
1. Connection pool exhaustion in checkout-service v3.4.1.
2. Payment service downstream network degradation.

## Prioritized Diagnostic Next Steps
1. Revert maxConnections setting from 25 to 100 on checkout-service.
2. Query pg_stat_activity to check waiting connections.
3. Inspect api-gateway circuit breaker metrics.`
      }
    ]
  };
  assert.equal(isAnalysisTruncated(msg), false);
});

test("4. report ending before Section 3 is classified as truncated", () => {
  const msg = {
    role: "assistant",
    parts: [
      {
        type: "text",
        text: `## Incident Summary & Confirmed Facts
Elevated 504 Gateway Timeouts on Checkout API.

## Ranked Root-Cause Hypotheses
1. Connection pool exhaustion following recent deployment.`
      }
    ]
  };
  assert.equal(isAnalysisTruncated(msg), true);
});

test("5. report containing Section 3's heading but no meaningful diagnostic content is truncated", () => {
  // Case A: heading with only trailing whitespace
  const msgEmptyHeading = {
    role: "assistant",
    parts: [
      {
        type: "text",
        text: `## Incident Summary & Confirmed Facts
Facts here.

## Ranked Root-Cause Hypotheses
1. Hypothesis 1.

## Prioritized Diagnostic Next Steps
`
      }
    ]
  };
  assert.equal(isAnalysisTruncated(msgEmptyHeading), true);

  // Case B: heading with dangling empty list marker
  const msgDanglingMarker = {
    role: "assistant",
    parts: [
      {
        type: "text",
        text: `## Incident Summary & Confirmed Facts
Facts here.

## Ranked Root-Cause Hypotheses
1. Hypothesis 1.

## Prioritized Diagnostic Next Steps
1. `
      }
    ]
  };
  assert.equal(isAnalysisTruncated(msgDanglingMarker), true);
});

test("6. report cut off within Section 3 is detected by fallback heuristics", () => {
  // Case 6a: Cut off with a dangling connective word
  const msgDanglingConnective = {
    role: "assistant",
    parts: [
      {
        type: "text",
        text: `## Incident Summary & Confirmed Facts
Elevated 504s on checkout API.

## Ranked Root-Cause Hypotheses
1. Connection pool exhaustion.

## Prioritized Diagnostic Next Steps
1. Revert connection pool settings in checkout-service.
2. Inspect downstream payment gateway latency by querying Prometheus for`
      }
    ]
  };
  assert.equal(isAnalysisTruncated(msgDanglingConnective), true);

  // Case 6b: Cut off with unclosed code backtick
  const msgUnclosedBacktick = {
    role: "assistant",
    parts: [
      {
        type: "text",
        text: `## Incident Summary & Confirmed Facts
Elevated 504s.

## Ranked Root-Cause Hypotheses
1. Pool exhaustion.

## Prioritized Diagnostic Next Steps
1. Revert maxConnections.
2. Check database status with \`pg_stat_activity`
      }
    ]
  };
  assert.equal(isAnalysisTruncated(msgUnclosedBacktick), true);

  // Case 6c: Cut off with dangling unfinished list item at bottom
  const msgDanglingListItem = {
    role: "assistant",
    parts: [
      {
        type: "text",
        text: `## Incident Summary & Confirmed Facts
Elevated 504s.

## Ranked Root-Cause Hypotheses
1. Pool exhaustion.

## Prioritized Diagnostic Next Steps
1. Step one verified.
2.`
      }
    ]
  };
  assert.equal(isAnalysisTruncated(msgDanglingListItem), true);
});

test("7. valid Markdown bullets without terminal punctuation are not flagged as truncated", () => {
  const msg = {
    role: "assistant",
    parts: [
      {
        type: "text",
        text: `## Incident Summary & Confirmed Facts
- Spike in 504 timeouts on checkout API

## Ranked Root-Cause Hypotheses
- Database pool exhaustion in checkout worker pool
- Downstream payment service network latency

## Prioritized Diagnostic Next Steps
- Revert checkout-service connection pool to 100
- Run database connection acquisition latency check
- Inspect api-gateway circuit breaker error rate`
      }
    ]
  };
  assert.equal(isAnalysisTruncated(msg), false);
});

test("8. user messages are not flagged as truncated even if containing partial text or length metadata", () => {
  const userMsgWithLength = {
    role: "user",
    metadata: { finishReason: "length" },
    parts: [{ type: "text", text: "## Incident Summary & Confirmed Facts" }]
  };
  assert.equal(isAnalysisTruncated(userMsgWithLength), false);

  const plainUserMsg = {
    role: "user",
    parts: [{ type: "text", text: "Please help troubleshoot this outage" }]
  };
  assert.equal(isAnalysisTruncated(plainUserMsg), false);
});

test("9. missing or malformed metadata does not throw errors", () => {
  assert.doesNotThrow(() => isAnalysisTruncated(undefined));
  assert.doesNotThrow(() => isAnalysisTruncated(null));
  assert.doesNotThrow(() => isAnalysisTruncated({}));
  assert.doesNotThrow(() => isAnalysisTruncated({ role: "assistant" }));
  assert.doesNotThrow(() => isAnalysisTruncated({ role: "assistant", metadata: "invalid string" }));
  assert.doesNotThrow(() => isAnalysisTruncated({ role: "assistant", metadata: 123 }));
  assert.doesNotThrow(() => isAnalysisTruncated({ role: "assistant", metadata: null }));
  assert.doesNotThrow(() => isAnalysisTruncated({ role: "assistant", metadata: { finishReason: null } }));
  assert.doesNotThrow(() => isAnalysisTruncated({ role: "assistant", parts: null }));
  assert.doesNotThrow(() => isAnalysisTruncated({ role: "assistant", parts: [null, undefined, {}] }));

  assert.equal(isAnalysisTruncated(null), false);
  assert.equal(isAnalysisTruncated({ role: "assistant", metadata: null }), false);
});

test("10. complete report with all sections is still classified as truncated if finishReason is length", () => {
  const msg = {
    role: "assistant",
    metadata: { finishReason: "length" },
    parts: [
      {
        type: "text",
        text: `## Incident Summary & Confirmed Facts
- Error rate on checkout spiked to 19.2% over 15 minutes.

## Ranked Root-Cause Hypotheses
1. Connection pool exhaustion.

## Prioritized Diagnostic Next Steps
1. Revert maxConnections setting from 25 to 100.
2. Query pg_stat_activity.
3. Inspect api-gateway circuit breaker.`
      }
    ]
  };
  // Explicit authoritative metadata takes precedence over complete section structure
  assert.equal(isAnalysisTruncated(msg), true);
});

test("11. unrelated assistant messages without Incident Summary are not classified as truncated", () => {
  const chatMsg = {
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "The current p99 latency for checkout-service is 342ms across all US regions."
      }
    ]
  };
  assert.equal(isAnalysisTruncated(chatMsg), false);
});

test("12. validateFollowUpMessage allows normal conversational follow-up questions", () => {
  const shortQuestion = "Can you check if there are database deadlocks in the logs?";
  const result = validateFollowUpMessage(shortQuestion);
  assert.equal(result.valid, true);

  const exactLimitQuestion = "a".repeat(CHAT_LIMITS.FOLLOW_UP_MAX_LENGTH);
  const resultLimit = validateFollowUpMessage(exactLimitQuestion);
  assert.equal(resultLimit.valid, true);
});

test("13. validateFollowUpMessage rejects follow-up questions exceeding 2,000 characters with user-friendly error", () => {
  const oversizedQuestion = "b".repeat(CHAT_LIMITS.FOLLOW_UP_MAX_LENGTH + 1);
  const result = validateFollowUpMessage(oversizedQuestion);
  assert.equal(result.valid, false);
  assert.match(result.error, /exceeds maximum length of 2000 characters/);
  assert.match(result.error, /got 2001/);
});

test("14. validateFollowUpMessage exempts initial structured incident analysis prompt from 2,000-char cap", () => {
  const structuredPrompt =
    "Please analyze the following production incident evidence.\n\n=== BEGIN UNTRUSTED INCIDENT DATA ===\n" +
    "c".repeat(5000) +
    "\n=== END UNTRUSTED INCIDENT DATA ===";
  const result = validateFollowUpMessage(structuredPrompt);
  assert.equal(result.valid, true);
});

test("15. extractMessageText extracts text from parts and content objects safely", () => {
  assert.equal(extractMessageText(null), "");
  assert.equal(extractMessageText(undefined), "");
  assert.equal(extractMessageText({ content: "Direct content string" }), "Direct content string");
  assert.equal(
    extractMessageText({
      parts: [
        { type: "text", text: "Part one" },
        { type: "reasoning", text: "Internal thought" },
        { type: "text", text: "Part two" }
      ]
    }),
    "Part one\nPart two"
  );
});
