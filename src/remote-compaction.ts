import type { Context, Model } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

type CompactionMessages = SessionBeforeCompactEvent["preparation"]["messagesToSummarize"];

// pi's extension loader can resolve a package root and its subpath against different
// installations when the caller's cwd is outside this package. Resolve the shared
// converter from this module's dependency tree and import its concrete file URL.
const piAiEntryUrl = import.meta.resolve("@earendil-works/pi-ai");
const sharedResponsesUrl = new URL("./api/openai-responses-shared.js", piAiEntryUrl).href;
const { convertResponsesMessages, convertResponsesTools } = await import(sharedResponsesUrl);

export const REMOTE_COMPACTION_KIND = "pi-codex-remote-compaction";
export const REMOTE_COMPACTION_VERSION = 1;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

export type ResponseItem = Record<string, unknown>;

export interface RemoteCompactionDetails {
  type: typeof REMOTE_COMPACTION_KIND;
  version: typeof REMOTE_COMPACTION_VERSION;
  checkpointId: string;
  endpoint: string;
  output: ResponseItem[];
  readFiles: string[];
  modifiedFiles: string[];
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
    details.version === REMOTE_COMPACTION_VERSION &&
    typeof details.checkpointId === "string" &&
    Array.isArray(details.output)
  );
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
  modelHeaders?: Record<string, string>,
  authHeaders?: Record<string, string>,
): Headers {
  const headers = new Headers(modelHeaders);
  for (const [name, value] of Object.entries(authHeaders ?? {})) headers.set(name, value);
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
  const converted = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
    grammarToolInputProperties: new Map([["apply_patch", "patch"]]),
  }) as unknown as ResponseItem[];
  return converted.map((item) => {
    if (
      item.type !== "custom_tool_call" ||
      typeof item.id !== "string" ||
      item.id.startsWith("ctc_")
    ) {
      return item;
    }

    // A call created before grammar tools used an fc_* function item ID. Pi's
    // shared converter correctly changes its replay type to custom_tool_call,
    // but Codex then requires a ctc_* ID. Omit the incompatible item ID rather
    // than inventing one: call_id still pairs the output, while a fabricated ID
    // could claim a nonexistent server-side reasoning association.
    const sanitized = { ...item };
    delete sanitized.id;
    return sanitized;
  });
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
  tools?: Array<{ name: string; description: string; parameters: any; constrainedSampling?: any }>;
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
    | { supportsOpenAIGrammarTools?: boolean; supportsStrictMode?: boolean }
    | undefined;
  const supportsOpenAIGrammarTools = compat?.supportsOpenAIGrammarTools ?? false;
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
    ...(options.tools?.length
      ? {
          tools: convertResponsesTools(options.tools, {
            strict: null,
            supportsStrictMode: compat?.supportsStrictMode ?? true,
            supportsOpenAIGrammarTools,
          }),
        }
      : {}),
    parallel_tool_calls: true,
    ...(effort ? { reasoning: { effort, summary: "auto" as const } } : {}),
    ...(options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {}),
    ...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
    text: { verbosity: "low" },
  };
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
} {
  const compactions: ResponseItem[] = [];
  let completed = false;
  let responseId: string | undefined;
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
    }
  }
  if (!completed) throw new Error("Codex remote compaction stream ended before response.completed");
  if (compactions.length !== 1) {
    throw new Error(
      `Codex remote compaction expected exactly one compaction item, got ${compactions.length}`,
    );
  }
  return { compaction: compactions[0], responseId };
}

export function buildReplacementHistory(
  requestInput: ResponseItem[],
  compaction: ResponseItem,
): ResponseItem[] {
  const retained: ResponseItem[] = [];
  let estimatedTokens = 0;
  for (const item of requestInput.slice(0, -1).reverse()) {
    const role = item.role;
    if (role !== "user" && role !== "developer" && role !== "system") continue;
    const itemTokens = Math.ceil(JSON.stringify(item).length / 4);
    if (estimatedTokens + itemTokens > 64_000) break;
    retained.push(item);
    estimatedTokens += itemTokens;
  }
  retained.reverse();
  retained.push(compaction);
  return retained;
}

function itemContainsMarker(item: unknown, marker: string): boolean {
  if (typeof item === "string") return item.includes(marker);
  if (Array.isArray(item)) return item.some((entry) => itemContainsMarker(entry, marker));
  if (!item || typeof item !== "object") return false;
  return Object.values(item).some((entry) => itemContainsMarker(entry, marker));
}

export function installRemoteCheckpoint(
  payload: unknown,
  details: RemoteCompactionDetails,
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const body = payload as { input?: unknown[] };
  if (!Array.isArray(body.input)) return payload;
  const marker = checkpointMarker(details.checkpointId);
  const index = body.input.findIndex((item) => itemContainsMarker(item, marker));
  if (index < 0) return payload;
  body.input.splice(index, 1, ...details.output);
  return payload;
}
