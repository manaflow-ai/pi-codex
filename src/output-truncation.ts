/**
 * The default comes from Codex's model metadata:
 * `truncation_policy: { type: "bytes", limit: 10_000 }`.
 */
export const CODEX_DEFAULT_OUTPUT_BUDGET_BYTES = 10_000;
const APPROX_BYTES_PER_TOKEN = 4;

export type CodexTruncationPolicy =
  | { type: "bytes"; limit: number }
  | { type: "tokens"; limit: number };

/**
 * Pi's public Model type does not yet carry Codex's server model metadata.
 * Accept the metadata when a provider supplies it, and retain Codex's
 * 10,000-byte default otherwise.
 */
export function resolveCodexTruncationPolicy(model: unknown): CodexTruncationPolicy {
  const candidate =
    model && typeof model === "object"
      ? (model as any).truncationPolicy ??
        (model as any).compat?.truncationPolicy
      : undefined;
  if (
    candidate &&
    (candidate.type === "bytes" || candidate.type === "tokens") &&
    Number.isSafeInteger(candidate.limit) &&
    candidate.limit >= 0
  ) {
    return { type: candidate.type, limit: candidate.limit };
  }
  return { type: "bytes", limit: CODEX_DEFAULT_OUTPUT_BUDGET_BYTES };
}

export interface CodexTruncationResult {
  content: string;
  truncated: boolean;
  originalBytes: number;
  omittedBytes: number;
}

function approxTokenCount(content: string): number {
  return Math.ceil(Buffer.byteLength(content, "utf8") / APPROX_BYTES_PER_TOKEN);
}

function validateLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error(`Truncation limit must be a non-negative safe integer, got ${limit}`);
  }
  return limit;
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split(/\r?\n/);
  // Rust's str::lines(), used by Codex, does not count the empty segment
  // after a terminal line ending.
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function splitMiddle(
  content: string,
  leftBudget: number,
  rightBudget: number,
): { left: string; right: string; removedChars: number } {
  const chars = Array.from(content);
  let leftCount = 0;
  let leftBytes = 0;
  for (; leftCount < chars.length; leftCount++) {
    const bytes = Buffer.byteLength(chars[leftCount], "utf8");
    if (leftBytes + bytes > leftBudget) break;
    leftBytes += bytes;
  }

  let rightCount = 0;
  let rightBytes = 0;
  for (; rightCount < chars.length - leftCount; rightCount++) {
    const char = chars[chars.length - rightCount - 1];
    const bytes = Buffer.byteLength(char, "utf8");
    if (rightBytes + bytes > rightBudget) break;
    rightBytes += bytes;
  }

  // The budgets normally cannot overlap because the caller only invokes this
  // function when the source exceeds the budget. Keep the guard for tiny
  // Unicode inputs and preserve a valid, non-overlapping result regardless.
  if (leftCount + rightCount > chars.length) {
    rightCount = Math.max(0, chars.length - leftCount);
  }

  return {
    left: chars.slice(0, leftCount).join(""),
    right: chars.slice(chars.length - rightCount).join(""),
    removedChars: chars.length - leftCount - rightCount,
  };
}

function middleTruncate(
  content: string,
  policy: CodexTruncationPolicy,
): { text: string; truncated: boolean } {
  const sourceBytes = Buffer.byteLength(content, "utf8");
  const byteBudget =
    policy.type === "bytes"
      ? validateLimit(policy.limit)
      : validateLimit(policy.limit) * APPROX_BYTES_PER_TOKEN;

  if (sourceBytes <= byteBudget) return { text: content, truncated: false };

  const markerUnit =
    policy.type === "bytes" ? "chars" : "tokens";
  if (byteBudget === 0) {
    const removed =
      policy.type === "bytes"
        ? Array.from(content).length
        : approxTokenCount(content);
    return {
      text: `…${removed} ${markerUnit} truncated…`,
      truncated: true,
    };
  }

  const leftBudget = Math.floor(byteBudget / 2);
  const rightBudget = byteBudget - leftBudget;
  const { left, right, removedChars } = splitMiddle(content, leftBudget, rightBudget);
  const removed =
    policy.type === "bytes"
      ? removedChars
      : Math.ceil(
          (sourceBytes - byteBudget) / APPROX_BYTES_PER_TOKEN,
        );
  return {
    text: `${left}…${removed} ${markerUnit} truncated…${right}`,
    truncated: true,
  };
}

/** Return only the middle-truncated payload, without Codex's warning header. */
export function truncateCodexText(
  content: string,
  policy: CodexTruncationPolicy,
): string {
  return middleTruncate(content, policy).text;
}

/**
 * Format output exactly like Codex's `formatted_truncate_text`.
 *
 * The policy applies to the middle-truncated payload. Codex prepends the
 * warning after truncating, so the complete formatted string is intentionally
 * larger than the raw byte budget.
 */
export function formatCodexTruncatedOutput(
  content: string,
  policy: CodexTruncationPolicy = {
    type: "bytes",
    limit: CODEX_DEFAULT_OUTPUT_BUDGET_BYTES,
  },
): CodexTruncationResult {
  const originalBytes = Buffer.byteLength(content, "utf8");
  const truncated = middleTruncate(content, policy);
  if (!truncated.truncated) {
    return { content, truncated: false, originalBytes, omittedBytes: 0 };
  }

  const formatted =
    `Warning: truncated output (original token count: ${approxTokenCount(content)})\n` +
    `Total output lines: ${lineCount(content)}\n\n${truncated.text}`;
  const rawBudget =
    policy.type === "bytes"
      ? policy.limit
      : policy.limit * APPROX_BYTES_PER_TOKEN;
  return {
    content: formatted,
    truncated: true,
    originalBytes,
    omittedBytes: Math.max(0, originalBytes - rawBudget),
  };
}

/** Apply Codex's default model-facing output contract. */
export function truncateCodexOutput(
  content: string,
  budget: number | CodexTruncationPolicy = CODEX_DEFAULT_OUTPUT_BUDGET_BYTES,
): CodexTruncationResult {
  const policy: CodexTruncationPolicy =
    typeof budget === "number" ? { type: "bytes", limit: budget } : budget;
  return formatCodexTruncatedOutput(content, policy);
}
