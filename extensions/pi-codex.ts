import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum, type Model } from "@earendil-works/pi-ai";
import {
  renderDiff,
  SettingsManager,
  type ToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  CODEX_APPLY_PATCH_FLAG,
  resolveCodexExecutable,
} from "../src/codex-binary.ts";
import {
  buildCompactHeaders,
  buildCompactRequest,
  buildReplacementHistory,
  checkpointMarker,
  convertCodexTools,
  fingerprintContext,
  fetchRemoteCompaction,
  fingerprintCheckpointSuffix,
  installRemoteCheckpoint,
  isRemoteCompactionDetails,
  parseRemoteCompactionSse,
  retainedContextItems,
  REMOTE_COMPACTION_VERSION,
  toPiUsage,
  type RemoteCompactionDetails,
  resolveCompactUrl,
} from "../src/remote-compaction.ts";
import {
  buildWebSearchInput,
  fetchCodexWebSearch,
  resolveWebSearchUrl,
  summarizeWebSearchCommands,
  type WebSearchCommands,
  type WebSearchDetails,
} from "../src/web-search.ts";
import {
  ToolContractRegistry,
  fingerprintToolSpecs,
} from "../src/tool-contract.ts";
import {
  CODEX_DEFAULT_OUTPUT_BUDGET_BYTES,
  resolveCodexTruncationPolicy,
  truncateCodexOutput,
  type CodexTruncationPolicy,
} from "../src/output-truncation.ts";

const grammarPath = fileURLToPath(new URL("../src/apply-patch.lark", import.meta.url));
const applyPatchGrammar = readFileSync(grammarPath, "utf8");
const replacedTools = ["edit", "write"] as const;
const codingAgentEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const compactionComponentUrl = new URL(
  "./modes/interactive/components/compaction-summary-message.js",
  codingAgentEntryUrl,
).href;
const { CompactionSummaryMessageComponent } = await import(compactionComponentUrl);
const editDiffUrl = new URL("./core/tools/edit-diff.js", codingAgentEntryUrl).href;
const { generateDiffString } = await import(editDiffUrl);
const compactRendererMarker: unique symbol = Symbol.for(
  "pi-codex.compact-compaction-renderer.v1",
) as any;
const CODEX_SOL_CONTEXT_WINDOW = 272_000;
const CODEX_SOL_AUTO_COMPACT_LIMIT = codexAutoCompactLimit(CODEX_SOL_CONTEXT_WINDOW);
const CODEX_SOL_RESERVE_TOKENS = codexCompactionReserve(CODEX_SOL_CONTEXT_WINDOW);
const CODEX_FAST_SERVICE_TIER = "priority";
const CODEX_FAST_MODE_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);
const CODEX_FAST_MODE_ENTRY = "pi-codex-fast-mode";
const CODEX_FAST_MODE_STATUS = "pi-codex-fast-mode";
const STATIC_WORKING_INDICATOR = "●";
const compactionPatchMarker: unique symbol = Symbol.for(
  "pi-codex.provider-compaction-threshold.v1",
) as any;
let activeCodexContextWindow: number | undefined;

type PatchedSettingsPrototype = SettingsManager & {
  [compactionPatchMarker]?: true;
};

type PatchableCompactionComponent = {
  [compactRendererMarker]?: true;
  updateDisplay: () => void;
};

function installCompactCompactionRenderer() {
  const prototype =
    CompactionSummaryMessageComponent.prototype as PatchableCompactionComponent;
  if (prototype[compactRendererMarker]) return;

  const original = prototype.updateDisplay;
  prototype.updateDisplay = function () {
    // Keep expanded summaries readable, but make the normal status a single
    // content line with no vertical box padding.
    (this as any).paddingY = (this as any).expanded ? 1 : 0;
    original.call(this);
    if ((this as any).expanded) return;

    const children = (this as any).children as Array<{ text?: string }>;
    const label = children[0]?.text;
    const status = children.at(-1)?.text;
    if (typeof label !== "string" || typeof status !== "string") return;

    (this as any).clear();
    (this as any).addChild(new Text(`${label} ${status}`, 0, 0));
  };
  Object.defineProperty(prototype, compactRendererMarker, { value: true });
}

function isOpenAICodexModel(model: Model<any> | undefined): model is Model<any> {
  // Codex-compatible providers can be local/subrouter aliases while still
  // speaking the OpenAI Responses protocol. This controls Codex tool behavior;
  // remote compaction has a narrower capability check below.
  return model?.provider === "openai-codex" || model?.api === "openai-codex-responses";
}

function supportsCodexRemoteCompaction(
  model: Model<any> | undefined,
): model is Model<any> {
  if (!isOpenAICodexModel(model)) return false;
  const declared =
    (model as any).supportsRemoteCompaction ??
    (model.compat as any)?.supportsRemoteCompaction;
  if (typeof declared === "boolean") return declared;
  return model.provider === "openai-codex" || model.provider === "subrouter";
}

function isCodexSolModel(model: Model<any> | undefined): boolean {
  return isOpenAICodexModel(model) && model?.id === "gpt-5.6-sol";
}

function supportsCodexFastMode(model: Model<any> | undefined): boolean {
  return isOpenAICodexModel(model) && CODEX_FAST_MODE_MODELS.has(model?.id ?? "");
}

function codexAutoCompactLimit(contextWindow: number): number {
  return Math.floor(contextWindow * 0.9);
}

// pi compacts when usage > (window - reserve), while Codex compacts when
// usage >= auto_compact_token_limit. The extra token aligns the first trigger.
function codexCompactionReserve(contextWindow: number): number {
  return contextWindow - codexAutoCompactLimit(contextWindow) + 1;
}

function formatWorkingElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function installCodexCompactionThreshold() {
  const prototype = SettingsManager.prototype as PatchedSettingsPrototype;
  if (prototype[compactionPatchMarker]) return;

  const original = SettingsManager.prototype.getCompactionSettings;
  SettingsManager.prototype.getCompactionSettings = function () {
    const settings = original.call(this);
    if (!activeCodexContextWindow) return settings;
    return {
      ...settings,
      reserveTokens: codexCompactionReserve(activeCodexContextWindow),
    };
  };
  Object.defineProperty(prototype, compactionPatchMarker, { value: true });
}

const applyPatchSchema = Type.Object({
  patch: Type.String({
    description: "The complete *** Begin Patch ... *** End Patch payload",
  }),
});

const searchQuerySchema = Type.Object({
  q: Type.String(),
  recency: Type.Optional(Type.Integer({ minimum: 0 })),
  domains: Type.Optional(Type.Array(Type.String())),
});

const webSearchSchema = Type.Object({
  search_query: Type.Optional(Type.Array(searchQuerySchema, { maxItems: 4 })),
  image_query: Type.Optional(Type.Array(searchQuerySchema, { maxItems: 2 })),
  open: Type.Optional(
    Type.Array(
      Type.Object({
        ref_id: Type.String(),
        lineno: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
    ),
  ),
  click: Type.Optional(
    Type.Array(Type.Object({ ref_id: Type.String(), id: Type.Integer({ minimum: 0 }) })),
  ),
  find: Type.Optional(
    Type.Array(Type.Object({ ref_id: Type.String(), pattern: Type.String() })),
  ),
  screenshot: Type.Optional(
    Type.Array(
      Type.Object({
        ref_id: Type.String(),
        pageno: Type.Integer({ minimum: 0 }),
      }),
    ),
  ),
  finance: Type.Optional(
    Type.Array(
      Type.Object({
        ticker: Type.String(),
        type: StringEnum(["equity", "fund", "crypto", "index"] as const),
        market: Type.Optional(Type.String()),
      }),
    ),
  ),
  weather: Type.Optional(
    Type.Array(
      Type.Object({
        location: Type.String(),
        start: Type.Optional(Type.String()),
        duration: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
    ),
  ),
  sports: Type.Optional(
    Type.Array(
      Type.Object({
        tool: Type.Optional(StringEnum(["sports"] as const)),
        fn: StringEnum(["schedule", "standings"] as const),
        league: StringEnum(
          ["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"] as const,
        ),
        team: Type.Optional(Type.String()),
        opponent: Type.Optional(Type.String()),
        date_from: Type.Optional(Type.String()),
        date_to: Type.Optional(Type.String()),
        num_games: Type.Optional(Type.Integer({ minimum: 1 })),
        locale: Type.Optional(Type.String()),
      }),
    ),
  ),
  time: Type.Optional(
    Type.Array(Type.Object({ utc_offset: Type.String() })),
  ),
  response_length: Type.Optional(StringEnum(["short", "medium", "long"] as const)),
});

type ApplyPatchDetails = {
  patch: string;
  output: string;
  changedPaths: string[];
  diffs: Array<{ path: string; diff: string }>;
};

function isCodexModel(model: Model<any> | undefined): boolean {
  // Tool selection follows the wire protocol first. A subrouter alias may
  // expose the Codex Responses API without containing "codex" in its name.
  const modelId = model?.id ?? "";
  return isOpenAICodexModel(model) ||
    /(?:^|[-_.])codex(?:$|[-_.])/.test(modelId);
}

function changedPathsFromOutput(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.match(/^[AMD] (.+)$/)?.[1])
    .filter((path): path is string => path !== undefined);
}

function pathsFromPatch(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const path = line.match(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/)?.[1];
    const movePath = line.match(/^\*\*\* Move to: (.+)$/)?.[1];
    if (path) paths.add(path);
    if (movePath) paths.add(movePath);
  }
  return [...paths];
}

function continueAfterSteeringMessage(text: string): string {
  return [
    "<steering-message>",
    "Treat this as an update to the current task.",
    "Only abandon, stop, or replace the previous work if this message explicitly requests that.",
    "",
    text,
    "</steering-message>",
  ].join("\n");
}

function collapseSteeringMessages(text: string): string {
  const blocks = [
    ...text.matchAll(
      /<steering-message>\nTreat this as an update to the current task\.\nOnly abandon, stop, or replace the previous work if this message explicitly requests that\.\n\n([\s\S]*?)\n<\/steering-message>/g,
    ),
  ];
  if (blocks.length < 2) return text;

  let remainder = text;
  for (const block of blocks) remainder = remainder.replace(block[0], "");
  remainder = remainder.trim();
  if (remainder) return text;

  return continueAfterSteeringMessage(
    blocks.map((block) => block[1]).join("\n\n"),
  );
}

async function readPatchFile(cwd: string, path: string): Promise<string> {
  try {
    return await readFile(resolve(cwd, path), "utf8");
  } catch {
    return "";
  }
}

export default function piCodex(pi: ExtensionAPI) {
  installCodexCompactionThreshold();
  installCompactCompactionRenderer();
  let applyPatchSelected: boolean | undefined;
  let webSearchSelected: boolean | undefined;
  let retryTurnState: string | undefined;
  let turnState: string | undefined;
  let fastModeEnabled = true;
  let workingStartedAt: number | undefined;
  let workingTimer: ReturnType<typeof setInterval> | undefined;
  const removedForCodex = new Set<string>();
  const toolContracts = new ToolContractRegistry();
  let activeToolCatalogFingerprint = "";

  // Codex's model_visible_specs() contains direct tools only. Deferred
  // contracts stay registered for Pi's tool-search lifecycle and are included
  // in the catalog fingerprint, but must not be sent in the initial
  // compaction request.
  function activeCodexToolSpecs(includeDeferred = false) {
    return pi
      .getAllTools()
      .filter((tool) => pi.getActiveTools().includes(tool.name))
      .flatMap((tool) => {
        const contract = toolContracts.get(tool.name);
        if (contract?.exposure === "hidden") return [];
        if (contract && !contract.isDirect() && !includeDeferred) return [];
        const contractTool = contract?.toCodexTool();
        return [contractTool ?? {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...((tool as any).constrainedSampling
            ? { constrainedSampling: (tool as any).constrainedSampling }
            : {}),
        }];
      });
  }

  function activeCodexToolFingerprint(model: Model<any> | undefined): string {
    const tools = activeCodexToolSpecs();
    const deferredTools = activeCodexToolSpecs(true).filter(
      (tool) => !tools.some((direct) => direct.name === tool.name),
    );
    const directWireTools = model
      ? convertCodexTools(model, tools) ?? tools
      : tools;
    const deferredWireTools = model
      ? convertCodexTools(model, deferredTools) ?? deferredTools
      : deferredTools;
    return fingerprintToolSpecs([
      ...directWireTools,
      {
        name: "__pi_codex_deferred_tools__",
        tools: deferredWireTools,
      },
      {
        name: "__pi_codex_model_compat__",
        provider: model?.provider,
        model: model?.id,
        api: model?.api,
        contextWindow: model?.contextWindow,
        supportsStrictMode: (model?.compat as any)?.supportsStrictMode,
        supportsOpenAIGrammarTools: (model?.compat as any)?.supportsOpenAIGrammarTools,
        supportsToolSearch: (model?.compat as any)?.supportsToolSearch,
      },
    ]);
  }

  function outputPolicy(model: Model<any> | undefined, budget: number) {
    return budget === CODEX_DEFAULT_OUTPUT_BUDGET_BYTES
      ? resolveCodexTruncationPolicy(model)
      : { type: "bytes" as const, limit: budget };
  }

  function truncationUnits(
    text: string,
    policy: CodexTruncationPolicy,
  ): number {
    const bytes = Buffer.byteLength(text, "utf8");
    return policy.type === "bytes" ? bytes : Math.ceil(bytes / 4);
  }

  function latestRemoteCompaction(ctx: { sessionManager: { getBranch(): readonly any[] } }) {
    return [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((entry: any) => entry.type === "compaction" && isRemoteCompactionDetails(entry.details))
      ?.details as RemoteCompactionDetails | undefined;
  }

  function syncTools(model: Model<any> | undefined) {
    activeCodexContextWindow = isOpenAICodexModel(model)
      ? model?.contextWindow
      : undefined;
    const active = new Set(pi.getActiveTools());
    applyPatchSelected ??= active.has("apply_patch");
    webSearchSelected ??= active.has("web_search");

    if (isCodexModel(model) && applyPatchSelected) {
      active.add("apply_patch");
      for (const tool of replacedTools) {
        if (active.delete(tool)) removedForCodex.add(tool);
      }
    } else {
      active.delete("apply_patch");
      for (const tool of removedForCodex) active.add(tool);
      removedForCodex.clear();
    }
    if (isOpenAICodexModel(model) && webSearchSelected) active.add("web_search");
    else active.delete("web_search");

    pi.setActiveTools([...active]);
  }

  function restoreFastMode(ctx: { sessionManager: { getBranch(): readonly any[] } }) {
    const saved = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find(
        (entry: any) =>
          entry.type === "custom" &&
          entry.customType === CODEX_FAST_MODE_ENTRY &&
          typeof entry.data?.enabled === "boolean",
      );
    fastModeEnabled = saved?.data.enabled ?? true;
  }

  function updateFastModeStatus(ctx: any) {
    if (!ctx.hasUI) return;
    const visible = fastModeEnabled && supportsCodexFastMode(ctx.model);
    ctx.ui.setStatus(
      CODEX_FAST_MODE_STATUS,
      visible ? ctx.ui.theme.fg("accent", "fast") : undefined,
    );
  }

  function installSelectionFriendlyWorkingIndicator(ctx: any) {
    if (!ctx.hasUI) return;
    // Pi's default 80ms spinner writes to the terminal even when no streamed
    // content changed. Terminal writes clear an in-progress text selection, so
    // keep the same working row and status message with a static indicator.
    // This uses the public per-session UI API rather than disabling or patching
    // any other extension.
    ctx.ui.setWorkingIndicator({
      frames: [ctx.ui.theme.fg("accent", STATIC_WORKING_INDICATOR)],
    });
  }

  function startWorkingTicker(ctx: any) {
    if (!ctx.hasUI || workingTimer) return;
    workingStartedAt = Date.now();
    const update = () => {
      if (workingStartedAt === undefined) return;
      ctx.ui.setWorkingMessage(
        `Working (${formatWorkingElapsed(Date.now() - workingStartedAt)})...`,
      );
    };
    update();
    workingTimer = setInterval(update, 1_000);
    workingTimer.unref?.();
  }

  function stopWorkingTicker(ctx?: any) {
    if (workingTimer) clearInterval(workingTimer);
    workingTimer = undefined;
    workingStartedAt = undefined;
    if (ctx?.hasUI) ctx.ui.setWorkingMessage();
  }

  pi.registerCommand("fast", {
    description: "Toggle Codex Fast mode (usage: /fast [on|off|status])",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "status") {
        const supported = supportsCodexFastMode(ctx.model);
        ctx.ui.notify(
          supported
            ? `Codex Fast mode is ${fastModeEnabled ? "on" : "off"} for ${ctx.model?.id}.`
            : `${ctx.model?.provider ?? "No provider"}/${ctx.model?.id ?? "no model"} does not advertise Codex Fast mode.`,
          "info",
        );
        return;
      }
      if (action && !["on", "off", "toggle"].includes(action)) {
        ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
        return;
      }

      fastModeEnabled =
        action === "on" ? true : action === "off" ? false : !fastModeEnabled;
      pi.appendEntry(CODEX_FAST_MODE_ENTRY, { enabled: fastModeEnabled });
      updateFastModeStatus(ctx);
      const supportNote = supportsCodexFastMode(ctx.model)
        ? ""
        : " (the current model does not advertise Fast support)";
      ctx.ui.notify(
        `Codex Fast mode ${fastModeEnabled ? "enabled" : "disabled"}${supportNote}.`,
        "info",
      );
    },
  });

  const webSearchDefinition: ToolDefinition<typeof webSearchSchema> = {
    name: "web_search",
    label: "Web Search",
    description:
      "Search and browse the live web using OpenAI Codex search. Supports search queries, page opening, links, find-in-page, screenshots, finance, weather, sports, and time.",
    promptSnippet: "Search and browse current web information through OpenAI Codex",
    promptGuidelines: [
      "Use web_search for current, niche, or source-dependent information instead of answering from memory.",
      "Use web_search open, click, and find operations to inspect sources after searching.",
    ],
    parameters: webSearchSchema,
    async execute(_toolCallId, commands, signal, _onUpdate, ctx) {
      const model = ctx.model;
      if (!model || !isOpenAICodexModel(model)) {
        throw new Error("web_search requires an openai-codex model");
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        throw new Error(auth.ok ? "OpenAI Codex OAuth token is unavailable" : auth.error);
      }
      const providerAuth = await ctx.modelRegistry.getProviderAuth(model.provider);
      const endpoint = resolveWebSearchUrl(providerAuth?.auth.baseUrl ?? model.baseUrl);
      const input = buildWebSearchInput(ctx.sessionManager.getBranch());
      const result = await fetchCodexWebSearch({
        endpoint,
        token: auth.apiKey,
        model,
        authHeaders: auth.headers as Record<string, string | null> | undefined,
        commands: commands as WebSearchCommands,
        sessionId: ctx.sessionManager.getSessionId(),
        input,
        signal,
      });
      const modelOutput = truncateCodexOutput(
        result.text,
        outputPolicy(model, webSearchContract.outputBudgetBytes),
      );
      return {
        content: [{ type: "text", text: modelOutput.content }],
        details: {
          commands,
          endpoint,
          rawOutput: result.text,
          results: result.response.results,
        } satisfies WebSearchDetails,
      };
    },
    renderCall(commands, theme) {
      const summary = summarizeWebSearchCommands(commands as WebSearchCommands);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("web_search"))} ${theme.fg("muted", summary)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme, { isError }) {
      const rawOutput = (result.details as WebSearchDetails | undefined)?.rawOutput;
      const output =
        expanded && rawOutput
          ? rawOutput
          : result.content
              .map((item) => (item.type === "text" ? item.text : ""))
              .join("\n");
      const visible =
        expanded || output.length <= 2_000 ? output : `${output.slice(0, 2_000).trimEnd()}\n…`;
      return new Text(theme.fg(isError ? "error" : "toolOutput", visible), 0, 0);
    },
  };
  const webSearchContract = toolContracts.register(webSearchDefinition, {
    exposure: "direct",
    namespace: "web",
    search: { namespace: "web", keywords: ["browse", "search", "current information"] },
    schemaVersion: "1",
    capabilities: ["network", "external_context"],
    outputBudgetBytes: CODEX_DEFAULT_OUTPUT_BUDGET_BYTES,
  });
  pi.registerTool(webSearchContract.definition);

  const applyPatchDefinition: ToolDefinition<typeof applyPatchSchema> = {
    name: "apply_patch",
    label: "Apply Patch",
    description:
      "Use OpenAI Codex's apply_patch format to add, update, move, or delete files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
    promptSnippet: "Apply an OpenAI Codex patch to add, update, move, or delete files",
    promptGuidelines: [
      "Use apply_patch for manual file edits; send a complete `*** Begin Patch` through `*** End Patch` patch.",
      "Do not invoke apply_patch through bash or use bash commands to create or edit files.",
      "If another agent may have edited a file, or apply_patch reports missing expected lines, re-read the affected region and retry with a smaller, current-context hunk.",
    ],
    parameters: applyPatchSchema,
    constrainedSampling: {
      type: "grammar",
      variants: { openai_lark: applyPatchGrammar },
    },
    executionMode: "sequential",

    async execute(_toolCallId, { patch }, signal, _onUpdate, ctx) {
      const patchPaths = pathsFromPatch(patch);
      const before = new Map(
        await Promise.all(
          patchPaths.map(async (path) => [path, await readPatchFile(ctx.cwd, path)] as const),
        ),
      );
      const executable = resolveCodexExecutable();
      const result = await pi.exec(executable, [CODEX_APPLY_PATCH_FLAG, patch], {
        cwd: ctx.cwd,
        signal,
      });
      const output = [result.stdout.trimEnd(), result.stderr.trimEnd()]
        .filter(Boolean)
        .join("\n");
      const rawModelOutput = result.code === 0
        ? output || "Patch applied successfully."
        : output || `Codex apply_patch exited with status ${result.code}`;
      const modelOutput = truncateCodexOutput(
        rawModelOutput,
        outputPolicy(ctx.model, applyPatchContract.outputBudgetBytes),
      );

      if (result.code !== 0) {
        throw new Error(modelOutput.content);
      }

      const changedPaths = changedPathsFromOutput(result.stdout);
      const diffPaths = [...new Set([...patchPaths, ...changedPaths])];
      const diffs = (
        await Promise.all(
          diffPaths.map(async (path) => {
            const oldContent = before.get(path) ?? "";
            const newContent = await readPatchFile(ctx.cwd, path);
            const diff = generateDiffString(oldContent, newContent).diff;
            return diff ? { path, diff } : undefined;
          }),
        )
      ).filter((diff): diff is { path: string; diff: string } => diff !== undefined);

      return {
        content: [{ type: "text", text: modelOutput.content }],
        details: {
          patch,
          output,
          changedPaths,
          diffs,
        } satisfies ApplyPatchDetails,
      };
    },

    renderCall({ patch }, theme) {
      const paths = patch
        .split("\n")
        .map((line) => line.match(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/)?.[1])
        .filter((path): path is string => path !== undefined);
      const summary = paths.length > 0 ? paths.join(", ") : "patch";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("apply_patch"))} ${theme.fg("muted", summary)}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme, { isError }) {
      const details = result.details as ApplyPatchDetails | undefined;
      const renderedDiffs = details?.diffs
        .map(
          ({ path, diff }) =>
            `${theme.fg("muted", path)}\n${renderDiff(diff, { filePath: path })}`,
        )
        .join("\n\n");
      if (renderedDiffs) return new Text(renderedDiffs, 0, 0);
      const text = details?.changedPaths.length
        ? `Updated ${details.changedPaths.join(", ")}`
        : result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
      return new Text(theme.fg(isError ? "error" : "success", text), 0, 0);
    },
  };
  const applyPatchContract = toolContracts.register(applyPatchDefinition, {
    exposure: "direct",
    namespace: "coding",
    search: { namespace: "coding", keywords: ["edit", "write", "patch", "files"] },
    schemaVersion: "1",
    capabilities: ["filesystem", "mutation"],
    parallelism: "sequential",
    outputBudgetBytes: CODEX_DEFAULT_OUTPUT_BUDGET_BYTES,
  });
  pi.registerTool(applyPatchContract.definition);

  // Codex applies one model-facing output policy to every tool executor. Pi
  // exposes this as a post-execution hook, so package-owned tools can retain
  // their raw details while built-in and third-party tools receive the same
  // middle truncation before their result enters the next model request.
  pi.on("tool_result", (event, ctx) => {
    if (!isOpenAICodexModel(ctx.model)) return;
    if (toolContracts.get(event.toolName)) return;
    const policy = resolveCodexTruncationPolicy(ctx.model);
    const textIndexes = event.content.flatMap((item: any, index: number) =>
      item.type === "text" && typeof item.text === "string" ? [index] : [],
    );
    const units = textIndexes.map((index) =>
      truncationUnits((event.content[index] as any).text, policy),
    );
    const totalUnits = units.reduce((total, value) => total + value, 0);
    if (totalUnits <= policy.limit) return;

    // Retain the leading and trailing halves across all text slots. Each slot
    // stays on its original side of images or audio, so truncation cannot move
    // a later caption or question ahead of its associated attachment.
    const front = Array(units.length).fill(0) as number[];
    const back = Array(units.length).fill(0) as number[];
    let frontRemaining = Math.floor(policy.limit / 2);
    for (let index = 0; index < units.length && frontRemaining > 0; index++) {
      front[index] = Math.min(units[index], frontRemaining);
      frontRemaining -= front[index];
    }
    let backRemaining = policy.limit - Math.floor(policy.limit / 2);
    for (let index = units.length - 1; index >= 0 && backRemaining > 0; index--) {
      const available = units[index] - front[index];
      back[index] = Math.min(available, backRemaining);
      backRemaining -= back[index];
    }
    const allocations = new Map(
      textIndexes.map((contentIndex, textIndex) => [
        contentIndex,
        front[textIndex] + back[textIndex],
      ]),
    );
    const content = event.content.map((item: any, index: number) => {
      const limit = allocations.get(index);
      if (limit === undefined) return item;
      return {
        ...item,
        text: truncateCodexOutput(item.text, {
          type: policy.type,
          limit,
        }).content,
      };
    });
    return {
      content,
      details: event.details,
      isError: event.isError,
      usage: event.usage,
    };
  });

  // Steering is model-independent. Make an interruption additive by default
  // while preserving the user's ability to explicitly stop or replace the task.
  pi.on("input", (event) => {
    if (event.streamingBehavior !== "steer") return;
    return {
      action: "transform",
      text: continueAfterSteeringMessage(event.text),
    };
  });

  // In "all" delivery mode, pi may combine several queued steering inputs into
  // one user message. Remove the repeated instructions before model requests.
  pi.on("context", (event) => {
    let changed = false;
    const messages = event.messages.map((message) => {
      if (message.role !== "user") return message;
      if (typeof message.content === "string") {
        const content = collapseSteeringMessages(message.content);
        if (content === message.content) return message;
        changed = true;
        return { ...message, content };
      }
      let messageChanged = false;
      const content = message.content.map((item) => {
        if (item.type !== "text") return item;
        const text = collapseSteeringMessages(item.text);
        if (text === item.text) return item;
        changed = true;
        messageChanged = true;
        return { ...item, text };
      });
      return messageChanged ? { ...message, content } : message;
    });
    if (changed) return { messages };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    if (!supportsCodexRemoteCompaction(model)) return;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      throw new Error(auth.ok ? "OpenAI Codex OAuth token is unavailable" : auth.error);
    }

    const providerAuth = await ctx.modelRegistry.getProviderAuth(model.provider);
    const previous = latestRemoteCompaction(ctx);
    const messages = [
      ...event.preparation.messagesToSummarize,
      ...event.preparation.turnPrefixMessages,
    ];
    const endpoint = resolveCompactUrl(providerAuth?.auth.baseUrl ?? model.baseUrl);
    const checkpointId = randomUUID();
    activeToolCatalogFingerprint = activeCodexToolFingerprint(model);
    const body = buildCompactRequest({
      model,
      messages,
      previousOutput: previous?.output,
      instructions: ctx.getSystemPrompt(),
      customInstructions: event.customInstructions,
      thinkingLevel: ctx.thinkingLevel,
      promptCacheKey: ctx.sessionManager.getSessionId(),
      serviceTier:
        fastModeEnabled && supportsCodexFastMode(model)
          ? CODEX_FAST_SERVICE_TIER
          : undefined,
      tools: activeCodexToolSpecs(),
    });
    const { response, text: responseText } = await fetchRemoteCompaction(endpoint, {
      method: "POST",
      headers: buildCompactHeaders(
        auth.apiKey,
        model.headers as Record<string, string | null> | undefined,
        auth.headers as Record<string, string | null> | undefined,
      ),
      body: JSON.stringify(body),
      signal: event.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Codex remote compaction failed (${response.status}): ${responseText || response.statusText}`,
      );
    }

    const parsedCompaction = parseRemoteCompactionSse(responseText);
    const { compaction } = parsedCompaction;
    const output = buildReplacementHistory(body.input, compaction);
    const retainedContext = retainedContextItems(
      model,
      ctx.sessionManager.getBranch(),
      event.preparation.firstKeptEntryId,
    );
    if (!retainedContext) {
      throw new Error(
        "Codex remote compaction could not establish the retained session context",
      );
    }

    const modifiedFiles = new Set([
      ...event.preparation.fileOps.written,
      ...event.preparation.fileOps.edited,
    ]);
    const readFiles = [...event.preparation.fileOps.read].filter(
      (path) => !modifiedFiles.has(path),
    );
    const details: RemoteCompactionDetails = {
      type: "pi-codex-remote-compaction",
      version: REMOTE_COMPACTION_VERSION,
      checkpointId,
      endpoint,
      output: output as Record<string, unknown>[],
      readFiles,
      modifiedFiles: [...modifiedFiles],
      responseId: parsedCompaction.responseId,
      turnState:
        response.headers.get("x-codex-turn-state") ??
        parsedCompaction.turnState,
      toolCatalogFingerprint: activeToolCatalogFingerprint,
      contextFingerprint: fingerprintContext(retainedContext),
      retainedContextItemCount: retainedContext.length,
      retainedHistoryVersion: "codex-responses-v2",
      tokenUsage: parsedCompaction.tokenUsage,
    };
    const responseTurnState =
      response.headers.get("x-codex-turn-state") ??
      parsedCompaction.turnState;
    if (responseTurnState) turnState = responseTurnState;
    retryTurnState = event.willRetry ? responseTurnState : undefined;

    return {
      compaction: {
        summary: checkpointMarker(checkpointId),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        ...(parsedCompaction.tokenUsage
          ? { usage: toPiUsage(parsedCompaction.tokenUsage) }
          : {}),
        details,
      },
    };
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!isOpenAICodexModel(ctx.model)) return;
    if (fastModeEnabled && supportsCodexFastMode(ctx.model)) {
      (event.payload as Record<string, unknown>).service_tier = CODEX_FAST_SERVICE_TIER;
    }
    const details = latestRemoteCompaction(ctx);
    if (details) {
      const currentToolCatalogFingerprint = activeCodexToolFingerprint(ctx.model);
      const input = ((event.payload as any)?.input ?? []) as readonly unknown[];
      const expectedContextFingerprint =
        details.contextFingerprint && details.retainedContextItemCount !== undefined
          ? fingerprintCheckpointSuffix(
              input,
              checkpointMarker(details.checkpointId),
              details.retainedContextItemCount,
            )
          : undefined;
      return installRemoteCheckpoint(event.payload, details, {
        toolCatalogFingerprint: currentToolCatalogFingerprint,
        ...(expectedContextFingerprint
          ? { contextFingerprint: expectedContextFingerprint }
          : {}),
      });
    }
  });

  pi.on("before_provider_headers", (event, ctx) => {
    if (!isOpenAICodexModel(ctx.model)) return;
    const state = retryTurnState ?? turnState;
    if (state) event.headers["x-codex-turn-state"] = state;
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (!isOpenAICodexModel(ctx.model)) return;
    const state =
      event.headers["x-codex-turn-state"] ??
      event.headers["X-Codex-Turn-State"];
    if (state) turnState ??= state;
  });

  pi.on("agent_end", () => {
    retryTurnState = undefined;
  });
  pi.on("turn_start", () => {
    retryTurnState = undefined;
    turnState = undefined;
  });
  pi.on("turn_end", () => {
    retryTurnState = undefined;
    turnState = undefined;
  });
  pi.on("agent_start", (_event, ctx) => {
    startWorkingTicker(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    stopWorkingTicker(ctx);
  });
  pi.on("session_start", (_event, ctx) => {
    retryTurnState = undefined;
    turnState = undefined;
    restoreFastMode(ctx);
    syncTools(ctx.model);
    updateFastModeStatus(ctx);
    installSelectionFriendlyWorkingIndicator(ctx);
  });
  pi.on("model_select", (event, ctx) => {
    syncTools(event.model);
    updateFastModeStatus(ctx);
  });
  pi.on("session_shutdown", () => {
    stopWorkingTicker();
  });
}

export {
  applyPatchGrammar,
  changedPathsFromOutput,
  CODEX_FAST_MODE_MODELS,
  CODEX_FAST_SERVICE_TIER,
  CODEX_SOL_AUTO_COMPACT_LIMIT,
  CODEX_SOL_CONTEXT_WINDOW,
  CODEX_SOL_RESERVE_TOKENS,
  collapseSteeringMessages,
  codexAutoCompactLimit,
  codexCompactionReserve,
  continueAfterSteeringMessage,
  formatWorkingElapsed,
  installCompactCompactionRenderer,
  isCodexModel,
  isCodexSolModel,
  isOpenAICodexModel,
  pathsFromPatch,
  supportsCodexFastMode,
};
