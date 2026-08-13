import { createHash } from "node:crypto";
import type { Context, Model, Usage } from "@earendil-works/pi-ai";
import {
  convertResponsesMessages,
  convertResponsesTools,
} from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
  convertToLlm,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  stableJson,
} from "./tool-contract.ts";
import {
  truncateCodexText,
} from "./output-truncation.ts";

type CompactionMessages = SessionBeforeCompactEvent["preparation"]["messagesToSummarize"];

export const REMOTE_COMPACTION_KIND = "pi-codex-remote-compaction";
export const REMOTE_COMPACTION_VERSION = 2;
const LEGACY_REMOTE_COMPACTION_VERSION = 1;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const RETAINED_HISTORY_TOKEN_BUDGET = 64_000;
const MAX_RETAINED_AGENT_MESSAGE_TOKENS = 16_000;

export type ResponseItem = Record<string, unknown>;

export interface RemoteCompactionDetails {
  type: typeof REMOTE_COMPACTION_KIND;
  version: typeof REMOTE_COMPACTION_VERSION | typeof LEGACY_REMOTE_COMPACTION_VERSION;
  checkpointId: string;
  endpoint: string;
  output: ResponseItem[];
  readFiles: string[];
  modifiedFiles: string[];
  responseId?: string;
  turnState?: string;
  toolCatalogFingerprint?: string;
  contextFingerprint?: string;
  retainedHistoryVersion?: string;
  tokenUsage?: Record<string, unknown>;
}

export interface CompactRequest {
  model: string;
  store: false;
  stream: true;
  input: ResponseItem[];
  instructions: string;
  include: ["reasoning.encrypted_content"];
  tool_choice: "auto";
  tools?: unknown[];
  parallel_tool_calls: boolean;
  reasoning?: { effort: string; summary: "auto" };
  prompt_cache_key?: string;
  service_tier?: string;
  text: { verbosity: "low" };
}

export function isRemoteCompactionDetails(value: unknown): value is RemoteCompactionDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as Partial<RemoteCompactionDetails>;
  return (
    details.type === REMOTE_COMPACTION_KIND &&
    (details.version === REMOTE_COMPACTION_VERSION || details.version === LEGACY_REMOTE_COMPACTION_VERSION) &&
    typeof details.checkpointId === "string" &&
    typeof details.endpoint === "string" &&
    Array.isArray(details.output) &&
    (details.readFiles === undefined || Array.isArray(details.readFiles)) &&
    (details.modifiedFiles === undefined || Array.isArray(details.modifiedFiles)) &&
    (details.responseId === undefined || typeof details.responseId === "string") &&
    (details.turnState === undefined || typeof details.turnState === "string") &&
    (details.toolCatalogFingerprint === undefined ||
      typeof details.toolCatalogFingerprint === "string") &&
    (details.contextFingerprint === undefined ||
      typeof details.contextFingerprint === "string") &&
    (details.tokenUsage === undefined ||
      (typeof details.tokenUsage === "object" && details.tokenUsage !== null))
  );
}

export function fingerprintContext(items: readonly ResponseItem[]): string {
  return createHash("sha256").update(stableJson(items)).digest("hex");
}

/**
 * Normalize the synthetic compaction boundary so the pre-compaction request
 * (`compaction_trigger`) and Pi's persisted checkpoint marker can be compared
 * without treating the boundary token itself as context drift.
 */
export function fingerprintCheckpointInput(
  items: readonly unknown[],
  marker?: string,
): string {
  const normalized = items.map((item) => {
    if (
      (item && typeof item === "object" && (item as any).type === "compaction_trigger") ||
      (marker && itemContainsMarker(item, marker))
    ) {
      return { type: "compaction_trigger" };
    }
    return item;
  }) as ResponseItem[];
  return fingerprintContext(normalized);
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/** Convert Responses usage fields into the Usage shape Pi stores in compaction entries. */
export function toPiUsage(value: Record<string, unknown> | undefined): Usage | undefined {
  if (!value) return undefined;
  const inputDetails =
    value.input_tokens_details &&
    typeof value.input_tokens_details === "object"
      ? (value.input_tokens_details as Record<string, unknown>)
      : {};
  const outputDetails =
    value.output_tokens_details &&
    typeof value.output_tokens_details === "object"
      ? (value.output_tokens_details as Record<string, unknown>)
      : {};
  const rawInput = numeric(value.input_tokens ?? value.inputTokens);
  const output = numeric(value.output_tokens ?? value.outputTokens);
  const cacheRead = numeric(
    inputDetails.cached_tokens ??
      value.cached_input_tokens ??
      value.cache_read_input_tokens,
  );
  const cacheWrite = numeric(
    inputDetails.cache_write_tokens ??
      inputDetails.cache_creation_tokens ??
      value.cache_write_tokens ??
      value.cacheWriteTokens,
  );
  const input = Math.max(0, rawInput - cacheRead - cacheWrite);
  const reasoning = numeric(
    outputDetails.reasoning_tokens ??
      value.reasoning_output_tokens ??
      value.reasoningTokens,
  );
  const totalTokens =
    numeric(value.total_tokens ?? value.totalTokens) ||
    input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(reasoning > 0 ? { reasoning } : {}),
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function checkpointMarker(checkpointId: string): string {
  return `[pi-codex remote compaction ${checkpointId}]`;
}

export function resolveCompactUrl(baseUrl?: string): string {
  const raw = baseUrl?.trim() || "https://chatgpt.com/backend-api";
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

export function extractChatGptAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid JWT");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    if (typeof accountId !== "string" || accountId.length === 0) {
      throw new Error("account ID claim is missing");
    }
    return accountId;
  } catch (error) {
    throw new Error("Failed to extract ChatGPT account ID from Codex OAuth token", {
      cause: error,
    });
  }
}

export function buildCompactHeaders(
  token: string,
  modelHeaders?: Record<string, string | null>,
  authHeaders?: Record<string, string | null>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(modelHeaders ?? {})) {
    if (value == null) headers.delete(name);
    else headers.set(name, value);
  }
  for (const [name, value] of Object.entries(authHeaders ?? {})) {
    if (value == null) headers.delete(name);
    else headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${token}`);
  if (!headers.has("chatgpt-account-id")) {
    headers.set("chatgpt-account-id", extractChatGptAccountId(token));
  }
  headers.set("originator", "pi-codex");
  headers.set("openai-beta", "responses=experimental");
  const betaFeatures = new Set(
    (headers.get("x-codex-beta-features") ?? "")
      .split(",")
      .map((feature) => feature.trim())
      .filter(Boolean),
  );
  betaFeatures.add("remote_compaction_v2");
  headers.set("x-codex-beta-features", [...betaFeatures].join(","));
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  return headers;
}

export function convertCompactionMessages(
  model: Model<any>,
  messages: CompactionMessages,
): ResponseItem[] {
  const context: Context = { messages: convertToLlm(messages) };
  return convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
    grammarToolInputProperties: new Map([["apply_patch", "patch"]]),
  }) as unknown as ResponseItem[];
}

export function buildCompactRequest(options: {
  model: Model<any>;
  messages: CompactionMessages;
  previousOutput?: ResponseItem[];
  instructions: string;
  customInstructions?: string;
  thinkingLevel?: string;
  promptCacheKey?: string;
  serviceTier?: string;
  tools?: Array<{
    name: string;
    description: string;
    parameters: any;
    constrainedSampling?: any;
    defer_loading?: boolean;
  }>;
}): CompactRequest {
  const mappedEffort = options.thinkingLevel
    ? options.model.thinkingLevelMap?.[options.thinkingLevel as keyof typeof options.model.thinkingLevelMap] ??
      options.thinkingLevel
    : undefined;
  const effort = mappedEffort && mappedEffort !== "off" ? mappedEffort : undefined;
  const instructions = options.customInstructions
    ? `${options.instructions}\n\nCompaction focus requested by the user:\n${options.customInstructions}`
    : options.instructions;

  const compat = options.model.compat as
    | {
        supportsOpenAIGrammarTools?: boolean;
        supportsStrictMode?: boolean;
        supportsParallelToolCalls?: boolean;
      }
    | undefined;
  const supportsOpenAIGrammarTools = compat?.supportsOpenAIGrammarTools ?? false;
  const parallelToolCalls =
    (options.model as any).supportsParallelToolCalls ??
    compat?.supportsParallelToolCalls ??
    true;
  const convertedTools = convertCodexTools(options.model, options.tools);

  return {
    model: options.model.id,
    store: false,
    stream: true,
    input: [
      ...(options.previousOutput ?? []),
      ...convertCompactionMessages(options.model, options.messages),
      { type: "compaction_trigger" },
    ],
    instructions,
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    ...(convertedTools?.length ? { tools: convertedTools } : {}),
    parallel_tool_calls: parallelToolCalls,
    ...(effort ? { reasoning: { effort, summary: "auto" as const } } : {}),
    ...(options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {}),
    ...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
    text: { verbosity: "low" },
  };
}

/** Convert the package contract into the same wire shape Pi uses for a turn. */
export function convertCodexTools(
  model: Model<any>,
  tools: NonNullable<CompactRequest["tools"]> | undefined,
): unknown[] | undefined {
  if (!tools?.length) return undefined;
  const compat = model.compat as
    | {
        supportsOpenAIGrammarTools?: boolean;
        supportsStrictMode?: boolean;
      }
    | undefined;
  const converted = convertResponsesTools(tools as any, {
    strict: null,
    supportsStrictMode: compat?.supportsStrictMode ?? true,
    supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools ?? false,
  });
  return converted.map((tool: any, index: number) =>
    (tools[index] as any)?.defer_loading
      ? { ...tool, defer_loading: true }
      : tool,
  );
}

const RETRYABLE_COMPACTION_STATUSES = new Set([429, 500, 502, 503, 504]);

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfterMs = Number(response.headers.get("retry-after-ms"));
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return retryAfterMs;
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000;
  return 1000 * 2 ** attempt;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Request was aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Request was aborted"));
      },
      { once: true },
    );
  });
}

export async function fetchRemoteCompaction(
  endpoint: string,
  init: RequestInit,
  maxRetries = 2,
): Promise<{ response: Response; text: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(endpoint, init);
      const text = await response.text();
      const terminalLimit = /usage.limit|insufficient.quota|out of budget/i.test(text);
      if (
        response.ok ||
        attempt === maxRetries ||
        !RETRYABLE_COMPACTION_STATUSES.has(response.status) ||
        terminalLimit
      ) {
        return { response, text };
      }
      await wait(retryDelayMs(response, attempt), init.signal as AbortSignal | undefined);
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || (init.signal as AbortSignal | undefined)?.aborted) throw error;
      await wait(1000 * 2 ** attempt, init.signal as AbortSignal | undefined);
    }
  }
  throw lastError ?? new Error("Codex remote compaction failed after retries");
}

export function parseRemoteCompactionSse(text: string): {
  compaction: ResponseItem;
  responseId?: string;
  tokenUsage?: Record<string, unknown>;
  turnState?: string;
} {
  const compactions: ResponseItem[] = [];
  let completed = false;
  let responseId: string | undefined;
  let tokenUsage: Record<string, unknown> | undefined;
  let turnState: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === "response.output_item.done" && event.item?.type === "compaction") {
      compactions.push(event.item);
    }
    if (event.type === "response.completed") {
      completed = true;
      responseId = event.response?.id ?? event.response_id;
      if (event.response?.usage && typeof event.response.usage === "object") {
        tokenUsage = event.response.usage;
      } else if (event.usage && typeof event.usage === "object") {
        tokenUsage = event.usage;
      }
      const candidateTurnState =
        event.response?.turn_state ??
        event.response?.metadata?.turn_state ??
        event.turn_state;
      if (typeof candidateTurnState === "string" && candidateTurnState.length > 0) {
        turnState = candidateTurnState;
      }
    }
  }
  if (!completed) throw new Error("Codex remote compaction stream ended before response.completed");
  if (!responseId) {
    throw new Error("Codex remote compaction response.completed did not include a response id");
  }
  if (compactions.length !== 1) {
    throw new Error(
      `Codex remote compaction expected exactly one compaction item, got ${compactions.length}`,
    );
  }
  return {
    compaction: compactions[0],
    ...(responseId ? { responseId } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(turnState ? { turnState } : {}),
  };
}

export function buildReplacementHistory(
  requestInput: ResponseItem[],
  compaction: ResponseItem,
): ResponseItem[] {
  const source =
    requestInput.at(-1)?.type === "compaction_trigger"
      ? requestInput.slice(0, -1)
      : requestInput;
  const candidates = source
    .filter(isRetainedHistoryItem);
  const retainedReversed: ResponseItem[] = [];
  let remainingTokens = RETAINED_HISTORY_TOKEN_BUDGET;

  // Codex keeps the newest retained messages first, then restores their
  // original order. This preserves the active tail when the transcript is
  // larger than the 64k replacement-history budget.
  for (let index = candidates.length - 1; index >= 0; index--) {
    const item = candidates[index];
    const itemTokens = estimateItemTokens(item);
    if (itemTokens <= remainingTokens) {
      retainedReversed.push(item);
      remainingTokens -= Math.max(1, itemTokens);
      continue;
    }

    const truncated = truncateRetainedMessage(item, remainingTokens);
    if (truncated) {
      retainedReversed.push(truncated);
      remainingTokens = 0;
    }
    break;
  }

  const retained = retainedReversed.reverse();
  retained.push(compaction);
  return retained;
}

function estimateItemTokens(item: unknown): number {
  if (item && typeof item === "object") {
    const candidate = item as Record<string, unknown>;
    if (
      (candidate.type === "message" ||
        candidate.role === "user" ||
        candidate.role === "assistant") &&
      candidate.content !== undefined
    ) {
      const textTokens = textTokenCount(candidate.content);
      if (textTokens > 0) return textTokens;
    }
  }
  return Math.max(1, Math.ceil(Buffer.byteLength(stableJson(item), "utf8") / 4));
}

function textTokenCount(value: unknown): number {
  if (typeof value === "string") {
    return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
  }
  if (Array.isArray(value)) {
    return value.reduce((total, entry) => total + textTokenCount(entry), 0);
  }
  if (!value || typeof value !== "object") return 0;
  const object = value as Record<string, unknown>;
  return typeof object.text === "string"
    ? Math.ceil(Buffer.byteLength(object.text, "utf8") / 4)
    : 0;
}

function isRetainedHistoryItem(item: ResponseItem): boolean {
  const type = typeof item.type === "string" ? item.type : undefined;
  if (type === "compaction" || type === "context_compaction") return true;
  if (type === "agent_message" || type === "agent") {
    return !isFinalAgentMessage(item) &&
      estimateItemTokens(item) <= MAX_RETAINED_AGENT_MESSAGE_TOKENS;
  }
  if (type !== undefined && type !== "message") return false;
  return (
    item.role === "user" ||
    item.role === "developer" ||
    item.role === "system"
  );
}

function isFinalAgentMessage(item: ResponseItem): boolean {
  const content = item.content;
  if (!Array.isArray(content)) return false;
  const first = content[0];
  const text =
    first && typeof first === "object" && typeof (first as any).text === "string"
      ? (first as any).text
      : undefined;
  return text?.startsWith("Message Type: FINAL_ANSWER\n") ?? false;
}

function truncateRetainedMessage(
  item: ResponseItem,
  remainingTokens: number,
): ResponseItem | undefined {
  if (remainingTokens <= 0) return undefined;
  const copy = structuredClone(item);
  let remaining = remainingTokens;
  let changed = false;

  const consumeText = (text: string): string | undefined => {
    if (remaining <= 0) return undefined;
    const tokens = textTokenCount(text);
    if (tokens <= remaining) {
      remaining -= tokens;
      return text;
    }
    const truncated = truncateCodexText(text, {
      type: "tokens",
      limit: remaining,
    });
    remaining = 0;
    return truncated || undefined;
  };

  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const next: unknown[] = [];
      for (const entry of value) {
        if (remaining <= 0) {
          // Preserve non-text content such as images, but omit more text.
          if (entry && typeof entry === "object" && "text" in entry) continue;
          next.push(entry);
          continue;
        }
        next.push(visit(entry));
      }
      return next;
    }
    if (!value || typeof value !== "object") return value;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "text" && typeof entry === "string") {
        changed = true;
        const text = consumeText(entry);
        if (text !== undefined) {
          next[key] = text;
        }
      } else {
        next[key] = visit(entry);
      }
    }
    return next;
  };

  const result = visit(copy);
  if (!changed && estimateItemTokens(result) > remainingTokens) return undefined;
  if (result && typeof result === "object") return result as ResponseItem;
  return undefined;
}

function itemContainsMarker(item: unknown, marker: string): boolean {
  if (typeof item === "string") return item.includes(marker);
  if (Array.isArray(item)) return item.some((entry) => itemContainsMarker(entry, marker));
  if (!item || typeof item !== "object") return false;
  return Object.values(item).some((entry) => itemContainsMarker(entry, marker));
}

function markerCount(item: unknown, marker: string): number {
  if (typeof item === "string") {
    return item.split(marker).length - 1;
  }
  if (Array.isArray(item)) {
    return item.reduce((count, entry) => count + markerCount(entry, marker), 0);
  }
  if (!item || typeof item !== "object") return 0;
  return Object.values(item).reduce(
    (count, entry) => count + markerCount(entry, marker),
    0,
  );
}

export function installRemoteCheckpoint(
  payload: unknown,
  details: RemoteCompactionDetails,
  expected?: { toolCatalogFingerprint?: string; contextFingerprint?: string },
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  if (
    details.version === REMOTE_COMPACTION_VERSION &&
    (!details.toolCatalogFingerprint ||
      !expected?.toolCatalogFingerprint)
  ) return payload;
  if (
    expected?.toolCatalogFingerprint &&
    details.toolCatalogFingerprint &&
    expected.toolCatalogFingerprint !== details.toolCatalogFingerprint
  ) return payload;
  if (
    expected?.contextFingerprint &&
    details.contextFingerprint &&
    expected.contextFingerprint !== details.contextFingerprint
  ) return payload;
  const body = payload as { input?: unknown[] };
  if (!Array.isArray(body.input)) return payload;
  const marker = checkpointMarker(details.checkpointId);
  const matchingIndexes = body.input.flatMap((item, index) =>
    itemContainsMarker(item, marker) ? [index] : [],
  );
  // A checkpoint is stale when its marker is no longer present. Never replace
  // an unrelated request, preserving Subrouter and legacy session behavior.
  if (
    matchingIndexes.length !== 1 ||
    markerCount(body.input[matchingIndexes[0]], marker) !== 1 ||
    details.output.length === 0
  ) return payload;
  const index = matchingIndexes[0];
  body.input.splice(index, 1, ...details.output);
  return payload;
}
