import type { Model } from "@earendil-works/pi-ai";
import { extractChatGptAccountId } from "./remote-compaction.ts";

export type WebSearchQuery = {
  q: string;
  recency?: number;
  domains?: string[];
};

export type WebSearchCommands = {
  search_query?: WebSearchQuery[];
  image_query?: WebSearchQuery[];
  open?: Array<{ ref_id: string; lineno?: number }>;
  click?: Array<{ ref_id: string; id: number }>;
  find?: Array<{ ref_id: string; pattern: string }>;
  screenshot?: Array<{ ref_id: string; pageno: number }>;
  finance?: Array<{
    ticker: string;
    type: "equity" | "fund" | "crypto" | "index";
    market?: string;
  }>;
  weather?: Array<{ location: string; start?: string; duration?: number }>;
  sports?: Array<{
    tool?: "sports";
    fn: "schedule" | "standings";
    league: "nba" | "wnba" | "nfl" | "nhl" | "mlb" | "epl" | "ncaamb" | "ncaawb" | "ipl";
    team?: string;
    opponent?: string;
    date_from?: string;
    date_to?: string;
    num_games?: number;
    locale?: string;
  }>;
  time?: Array<{ utc_offset: string }>;
  response_length?: "short" | "medium" | "long";
};

export type WebSearchResponse = {
  encrypted_output?: string | null;
  output: string;
  results?: unknown[];
};

export type WebSearchDetails = {
  commands: WebSearchCommands;
  endpoint: string;
  rawOutput: string;
  results?: unknown[];
};

export const WEB_SEARCH_DETAILS_LIMIT_BYTES = 50_000;

export function resolveWebSearchUrl(baseUrl?: string): string {
  const raw = baseUrl?.trim() || "https://chatgpt.com/backend-api";
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/alpha/search")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/alpha/search`;
  return `${normalized}/codex/alpha/search`;
}

export function buildWebSearchHeaders(
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
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  return headers;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item !== null &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

export function buildWebSearchInput(branch: readonly any[]): Array<Record<string, unknown>> | undefined {
  const visible = branch
    .filter((entry) => entry?.type === "message")
    .map((entry) => entry.message)
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      text: textFromContent(message.content),
    }))
    .filter((message) => message.text.length > 0);

  let users = 0;
  let start = visible.length;
  for (let index = visible.length - 1; index >= 0; index--) {
    if (visible[index].role === "user") users++;
    start = index;
    if (users === 2) break;
  }

  const input = visible.slice(start).map((message) => ({
    type: "message",
    role: message.role,
    content: [
      message.role === "user"
        ? { type: "input_text", text: message.text }
        : { type: "output_text", text: message.text },
    ],
  }));
  return input.length > 0 ? input : undefined;
}

function maxOutputTokens(responseLength: WebSearchCommands["response_length"]): number {
  if (responseLength === "short") return 2_000;
  if (responseLength === "long") return 10_000;
  return 5_000;
}

export async function fetchCodexWebSearch(options: {
  endpoint: string;
  token: string;
  model: Model<any>;
  authHeaders?: Record<string, string | null>;
  commands: WebSearchCommands;
  sessionId: string;
  input?: Array<Record<string, unknown>>;
  signal?: AbortSignal;
}): Promise<{
  text: string;
  response: WebSearchResponse;
}> {
  const response = await fetch(options.endpoint, {
    method: "POST",
    headers: buildWebSearchHeaders(
      options.token,
      options.model.headers as Record<string, string | null> | undefined,
      options.authHeaders,
    ),
    body: JSON.stringify({
      id: options.sessionId,
      model: options.model.id,
      ...(options.input ? { input: options.input } : {}),
      commands: options.commands,
      settings: {
        allowed_callers: ["direct"],
        external_web_access: true,
      },
      max_output_tokens: maxOutputTokens(options.commands.response_length),
    }),
    signal: options.signal,
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Codex web search failed (${response.status}): ${responseText || response.statusText}`,
    );
  }

  let payload: WebSearchResponse;
  try {
    payload = JSON.parse(responseText) as WebSearchResponse;
  } catch (error) {
    throw new Error("Codex web search returned invalid JSON", { cause: error });
  }
  if (typeof payload.output !== "string") {
    throw new Error("Codex web search response did not include output");
  }

  return {
    // Keep the provider response intact. Codex's output policy belongs at the
    // model boundary, where the caller can preserve raw details separately.
    text: payload.output,
    response: payload,
  };
}

export function summarizeWebSearchCommands(commands: WebSearchCommands): string {
  const queries = commands.search_query ?? commands.image_query;
  if (queries?.length) return queries.map((query) => query.q).join(", ");
  if (commands.open?.length) return `open ${commands.open[0].ref_id}`;
  if (commands.click?.length) return `click ${commands.click[0].ref_id}#${commands.click[0].id}`;
  if (commands.find?.length) return `find ${commands.find[0].pattern}`;
  if (commands.weather?.length) return `weather ${commands.weather[0].location}`;
  if (commands.finance?.length) return `finance ${commands.finance[0].ticker}`;
  if (commands.sports?.length) return `${commands.sports[0].league} ${commands.sports[0].fn}`;
  if (commands.time?.length) return `time ${commands.time[0].utc_offset}`;
  return "web";
}

export function boundedWebSearchDetails(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= WEB_SEARCH_DETAILS_LIMIT_BYTES) {
    return text;
  }
  const suffix = "\n… raw output truncated …";
  const budget = WEB_SEARCH_DETAILS_LIMIT_BYTES - Buffer.byteLength(suffix, "utf8");
  const source = Buffer.from(text, "utf8");
  let end = budget;
  while (end > 0 && (source[end] & 0xc0) === 0x80) end--;
  return `${source.subarray(0, end).toString("utf8")}${suffix}`;
}
