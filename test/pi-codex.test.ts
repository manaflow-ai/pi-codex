import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  CompactionSummaryMessageComponent,
  initTheme,
  SettingsManager,
  shouldCompact,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import piCodex, {
  applyPatchGrammar,
  changedPathsFromOutput,
  CODEX_FAST_SERVICE_TIER,
  CODEX_SOL_AUTO_COMPACT_LIMIT,
  CODEX_SOL_CONTEXT_WINDOW,
  CODEX_SOL_RESERVE_TOKENS,
  collapseSteeringMessages,
  codexAutoCompactLimit,
  continueAfterSteeringMessage,
  formatWorkingElapsed,
  installCompactCompactionRenderer,
  isCodexModel,
  pathsFromPatch,
  supportsCodexFastMode,
} from "../extensions/pi-codex.ts";
import cmuxTabTitle, {
  buildWorkspaceInventory,
  fallbackTabTitle,
  isSyntheticBackgroundNotification,
  MAX_REQUEST_TIMELINE_ITEMS,
  MAX_SESSION_SUMMARY_CHARACTERS,
  MAX_LATEST_REQUEST_CHARACTERS,
  MAX_TITLE_CHARACTERS,
  parseGeneratedTitles,
  sanitizeTabTitle,
  serializeForkedSession,
  TITLE_MODEL,
  TITLE_THINKING_LEVEL,
  titleFromJsonEvents,
} from "../extensions/cmux-tab-title.ts";
import {
  CODEX_APPLY_PATCH_FLAG,
  resolveCodexExecutable,
} from "../src/codex-binary.ts";
import {
  buildReplacementHistory,
  buildCompactRequest,
  checkpointMarker,
  fingerprintCheckpointInput,
  fingerprintCheckpointSuffix,
  installRemoteCheckpoint,
  isRemoteCompactionDetails,
  parseRemoteCompactionSse,
  resolveCompactUrl,
} from "../src/remote-compaction.ts";
import {
  CODEX_DEFAULT_OUTPUT_BUDGET_BYTES,
  formatCodexTruncatedOutput,
  truncateCodexText,
  truncateCodexOutput,
} from "../src/output-truncation.ts";
import {
  ToolContractRegistry,
  createToolContract,
  fingerprintToolCatalog,
} from "../src/tool-contract.ts";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  buildWebSearchHeaders,
  resolveWebSearchUrl,
  summarizeWebSearchCommands,
} from "../src/web-search.ts";

function run(executable: string, args: string[], cwd: string, input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
}

test("steering messages tell every model to continue prior work by default", () => {
  assert.equal(
    continueAfterSteeringMessage("Also cover the error case."),
    [
      "<steering-message>",
      "Treat this as an update to the current task.",
      "Only abandon, stop, or replace the previous work if this message explicitly requests that.",
      "",
      "Also cover the error case.",
      "</steering-message>",
    ].join("\n"),
  );
});

test("combined steering inputs collapse into one instruction block", () => {
  const first = continueAfterSteeringMessage("Keep the answer to two lines.");
  const second = continueAfterSteeringMessage("Use the existing terminology.");
  assert.equal(
    collapseSteeringMessages(`${first}\n\n${second}`),
    continueAfterSteeringMessage(
      "Keep the answer to two lines.\n\nUse the existing terminology.",
    ),
  );
});

test("cmux tab titles are short and omit session IDs", () => {
  assert.equal(
    sanitizeTabTitle('Title: "Context-aware cmux tabs · pi-019fc746-9cfa"'),
    "Context-aware cmux tabs",
  );
  assert.equal(
    sanitizeTabTitle("Fix authentication · 019fc746-9cfa-4cf1-a13d-39e5fe2ac3ca"),
    "Fix authentication",
  );
  assert.ok(Array.from(sanitizeTabTitle("A deliberately very long title that should be cut at a useful word boundary")).length <= MAX_TITLE_CHARACTERS);
});

test("cmux fallback titles summarize the latest prompt without refs", () => {
  assert.equal(
    fallbackTabTitle("Could you add contextual cmux tab naming for workspace:96?"),
    "add contextual cmux tab naming",
  );
});

test("cmux title subagent parses the final assistant event", () => {
  const output = [
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "First title" }] } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Contextual tab titles" }] } }),
  ].join("\n");
  assert.equal(titleFromJsonEvents(output), "Contextual tab titles");
});

test("cmux workspace inventory includes every surface in the scoped workspace", () => {
  const callerId = "11111111-1111-4111-8111-111111111111";
  const tree = JSON.stringify({
    windows: [{
      workspaces: [{
        title: "Old workspace · pi-019fc746-9cfa",
        panes: [
          {
            surfaces: [{
              id: callerId,
              ref: "surface:1",
              title: "Old caller title · pi-019fc746-9cfa",
              type: "terminal",
              here: true,
              active: true,
              url: null,
            }],
          },
          {
            surfaces: [{
              id: "22222222-2222-4222-8222-222222222222",
              ref: "surface:2",
              title: "Preview server · pi-019fc709-b178",
              type: "browser",
              here: false,
              active: false,
              url: "https://example.com/dashboard?secret=nope",
            }],
          },
        ],
      }],
    }],
  });
  const inventory = buildWorkspaceInventory(tree, callerId, "Context-aware titles");
  assert.deepEqual(inventory, {
    currentTitle: "Old workspace",
    surfaces: [
      {
        title: "Context-aware titles",
        type: "terminal",
        caller: true,
        active: true,
      },
      {
        title: "Preview server",
        type: "browser",
        url: "https://example.com/dashboard",
        caller: false,
        active: false,
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(inventory), /019fc|11111111|22222222/);
});

test("cmux workspace inventory rejects a stale workspace target", () => {
  const tree = JSON.stringify({
    windows: [{
      workspaces: [{
        id: "current-workspace",
        ref: "workspace:1",
        title: "Different workspace",
        panes: [],
      }],
    }],
  });
  assert.equal(
    buildWorkspaceInventory(
      tree,
      "caller-surface",
      "Fallback title",
      "stale-workspace",
    ),
    undefined,
  );
});

test("cmux naming subagent returns separate tab and workspace titles", () => {
  assert.deepEqual(
    parseGeneratedTitles(
      '```json\n{"tab":"Workspace-aware naming · pi-019fc746-9cfa","workspace":"Pi Extension UX","session":"Improve contextual naming and request visibility","requests":["Build latest-request widget","Add contextual tab names","Share compact request timeline"],"latest":"Share a compact request timeline … preserve my wording"}\n```',
      "Fallback title",
    ),
    {
      tab: "Workspace-aware naming",
      workspace: "Pi Extension UX",
      session: "Improve contextual naming and request visibility",
      requests: [
        "Build latest-request widget",
        "Add contextual tab names",
        "Share compact request timeline",
      ],
      latest: "Share a compact request timeline … preserve my wording",
    },
  );
  assert.equal(MAX_REQUEST_TIMELINE_ITEMS, 3);
  assert.equal(MAX_SESSION_SUMMARY_CHARACTERS, 80);
  assert.equal(MAX_LATEST_REQUEST_CHARACTERS, 240);
});

test("cmux naming always uses Codex 5.6 Luna at medium effort", () => {
  assert.equal(TITLE_MODEL, "openai-codex/gpt-5.6-luna");
  assert.equal(TITLE_THINKING_LEVEL, "medium");
});

test("cmux naming ignores synthetic background notification turns", () => {
  assert.equal(
    isSyntheticBackgroundNotification(`
      <background-job-notification>
        <job-id>abc123</job-id>
        <status>completed</status>
      </background-job-notification>
    `),
    true,
  );
  assert.equal(
    isSyntheticBackgroundNotification(`
      <background-monitor-notification>
        <monitor-id>monitor-1</monitor-id>
        <matches>CI passed</matches>
      </background-monitor-notification>
    `),
    true,
  );
  assert.equal(
    isSyntheticBackgroundNotification(`
      <cron-notification source="pi-cron" automated="true">
        <job-id>cron-1</job-id>
      </cron-notification>
    `),
    true,
  );
  assert.equal(
    isSyntheticBackgroundNotification(`
      <background-job-notification>
        <job-id>abc123</job-id>
      </background-job-notification>
      Please summarize what happened.
    `),
    false,
  );
  assert.equal(isSyntheticBackgroundNotification("Work on background jobs"), false);
});

test("cmux naming starts its cmux processes only after the message handler returns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cmux-background-test-"));
  const cmuxLog = join(directory, "cmux.log");
  const fakeCmux = join(directory, "cmux");
  const fakePi = join(directory, "pi");
  const environmentKeys = [
    "CMUX_PI_CMUX_BIN",
    "CMUX_SOCKET_PATH",
    "CMUX_SURFACE_ID",
    "CMUX_WORKSPACE_ID",
    "PI_CMUX_TAB_TITLE_PI_BIN",
    "PI_CMUX_TAB_TITLE_SUBAGENT",
    "CMUX_TEST_LOG",
  ] as const;
  const previousEnvironment = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]]),
  );

  try {
    await writeFile(
      fakeCmux,
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$CMUX_TEST_LOG"',
        'case " $* " in',
        '  *" --json tree "*) printf \'%s\\n\' \'{"windows":[]}\' ;;',
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );
    await writeFile(
      fakePi,
      [
        "#!/bin/sh",
        "printf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"{\\\"tab\\\":\\\"Background cmux naming\\\",\\\"workspace\\\":\\\"\\\"}\"}]}}'",
      ].join("\n"),
      { mode: 0o755 },
    );

    process.env.CMUX_PI_CMUX_BIN = fakeCmux;
    process.env.CMUX_SOCKET_PATH = join(directory, "cmux.sock");
    process.env.CMUX_SURFACE_ID = "test-surface";
    process.env.CMUX_WORKSPACE_ID = "test-workspace";
    process.env.PI_CMUX_TAB_TITLE_PI_BIN = fakePi;
    process.env.CMUX_TEST_LOG = cmuxLog;
    delete process.env.PI_CMUX_TAB_TITLE_SUBAGENT;

    let beforeAgentStart:
      | ((event: { prompt: string }, ctx: Record<string, unknown>) => unknown)
      | undefined;
    let sessionShutdown: (() => unknown) | undefined;
    cmuxTabTitle({
      on(event: string, handler: (...args: any[]) => unknown) {
        if (event === "before_agent_start") beforeAgentStart = handler;
        if (event === "session_shutdown") sessionShutdown = handler;
      },
    } as never);

    assert.ok(beforeAgentStart);
    const context = {
      mode: "tui",
      cwd: directory,
      sessionManager: {
        getSessionFile: () => join(directory, "source.jsonl"),
        getBranch: () => [],
      },
    };
    const notificationResult = beforeAgentStart(
      {
        prompt:
          "<background-job-notification><job-id>done</job-id></background-job-notification>",
      },
      context,
    );
    assert.equal(notificationResult, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(existsSync(cmuxLog), false);

    const result = beforeAgentStart(
      { prompt: "Keep cmux work in the background" },
      context,
    );
    assert.equal(result, undefined);
    assert.equal(existsSync(cmuxLog), false);

    const deadline = Date.now() + 2_000;
    while (!existsSync(cmuxLog) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(await readFile(cmuxLog, "utf8"), /rename-tab/);
    sessionShutdown?.();
  } finally {
    for (const key of environmentKeys) {
      const value = previousEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("cmux title snapshots contain every entry on the active branch", () => {
  const branch = [
    { type: "message", id: "one", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 } },
    { type: "message", id: "two", parentId: "one", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "second" }], timestamp: 2 } },
    { type: "message", id: "three", parentId: "two", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "third" }], timestamp: 3 } },
  ];
  const snapshot = serializeForkedSession({
    cwd: "/tmp/project",
    sessionManager: {
      getSessionFile: () => "/tmp/source.jsonl",
      getBranch: () => branch as never,
    },
  });
  const entries = snapshot.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries[0].type, "session");
  assert.equal(entries[0].parentSession, "/tmp/source.jsonl");
  assert.deepEqual(entries.slice(1), branch);
});

test("uses the upstream freeform apply_patch grammar", () => {
  assert.match(applyPatchGrammar, /^start: begin_patch hunk\+ end_patch/m);
  assert.match(applyPatchGrammar, /update_hunk:.*change_move\? change\?/);
  assert.match(applyPatchGrammar, /eof_line: "\*\*\* End of File" LF/);
});

test("pi-codex loads when Pi starts outside the package directory", async () => {
  const projectRoot = join(import.meta.dirname, "..");
  const result = await run(
    process.execPath,
    [
      join(
        projectRoot,
        "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      ),
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--extension",
      join(projectRoot, "extensions/pi-codex.ts"),
      "--offline",
    ],
    tmpdir(),
    `${JSON.stringify({ id: "state", type: "get_state" })}\n`,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"command":"get_state","success":true/);
});

test("recognizes Codex models", () => {
  assert.equal(isCodexModel({ provider: "openai-codex", id: "gpt-5.6-sol" } as never), true);
  assert.equal(isCodexModel({ provider: "openai", id: "gpt-5.3-codex" } as never), true);
  assert.equal(
    isCodexModel({
      provider: "subrouter",
      id: "gpt-5.6-sol",
      api: "openai-codex-responses",
    } as never),
    true,
  );
  assert.equal(isCodexModel({ provider: "openai", id: "gpt-5.4" } as never), false);
  assert.equal(
    supportsCodexFastMode({ provider: "openai-codex", id: "gpt-5.6-sol" } as never),
    true,
  );
  assert.equal(
    supportsCodexFastMode({ provider: "openai-codex", id: "gpt-5.4-mini" } as never),
    false,
  );
  assert.equal(
    supportsCodexFastMode({ provider: "openrouter", id: "openai/gpt-5.6-sol" } as never),
    false,
  );
});

test("resolves Codex standalone web search through provider base URLs", () => {
  assert.equal(
    resolveWebSearchUrl("http://subrouter.test/backend-api"),
    "http://subrouter.test/backend-api/codex/alpha/search",
  );
  assert.equal(
    resolveWebSearchUrl("https://chatgpt.com/backend-api/codex"),
    "https://chatgpt.com/backend-api/codex/alpha/search",
  );
  assert.equal(
    summarizeWebSearchCommands({ search_query: [{ q: "OpenAI Codex" }] }),
    "OpenAI Codex",
  );

  const tokenPayload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_search" },
  })).toString("base64url");
  const headers = buildWebSearchHeaders(
    `e30.${tokenPayload}.signature`,
    { "X-Subrouter-Agent": "pi" },
    { "X-Subrouter-Session": "search-session" },
  );
  assert.equal(headers.get("x-subrouter-agent"), "pi");
  assert.equal(headers.get("x-subrouter-session"), "search-session");
  assert.equal(headers.get("chatgpt-account-id"), "acct_search");
});

test("standalone web search executes through the subrouter and renders as a Pi tool", async () => {
  const tools = new Map<string, any>();
  const pi = {
    registerCommand() {},
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
    getActiveTools: () => ["web_search", "apply_patch"],
    getAllTools: () => [...tools.values()],
    setActiveTools() {},
    on() {},
  } as unknown as ExtensionAPI;
  piCodex(pi);

  const webSearch = tools.get("web_search");
  assert.ok(webSearch);
  const renderedCall = webSearch.renderCall(
    { search_query: [{ q: "OpenAI Codex" }] },
    {
      bold: (text: string) => text,
      fg: (_name: string, text: string) => text,
    },
  );
  assert.match(renderedCall.render(120).join("\n"), /web_search OpenAI Codex/);

  const tokenPayload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_render" },
  })).toString("base64url");
  const token = `e30.${tokenPayload}.signature`;
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(JSON.stringify({
      output: "Search result with source https://example.com",
      results: [{ url: "https://example.com" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const model = {
      provider: "openai-codex",
      id: "gpt-5.6-luna",
      headers: { "X-Subrouter-Agent": "pi" },
    };
    const result = await webSearch.execute(
      "search-1",
      { search_query: [{ q: "OpenAI Codex" }], response_length: "short" },
      new AbortController().signal,
      undefined,
      {
        model,
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({
            ok: true,
            apiKey: token,
            headers: { "X-Subrouter-Session": "render-test" },
          }),
          getProviderAuth: async () => ({
            auth: { baseUrl: "http://subrouter.test/backend-api" },
          }),
        },
        sessionManager: {
          getSessionId: () => "session-render",
          getBranch: () => [{
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "Search the web" }] },
          }],
        },
      },
    );
    assert.equal(
      requestedUrl,
      "http://subrouter.test/backend-api/codex/alpha/search",
    );
    const headers = new Headers(requestedInit?.headers);
    assert.equal(headers.get("x-subrouter-agent"), "pi");
    assert.equal(headers.get("x-subrouter-session"), "render-test");
    const body = JSON.parse(String(requestedInit?.body));
    assert.deepEqual(body.commands.search_query, [{ q: "OpenAI Codex" }]);
    assert.equal(result.details.endpoint, requestedUrl);

    const renderedResult = webSearch.renderResult(
      result,
      { expanded: false },
      { fg: (_name: string, text: string) => text },
      { isError: false },
    );
    assert.match(
      renderedResult.render(120).join("\n"),
      /Search result with source https:\/\/example\.com/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extracts changed paths from Codex output", () => {
  assert.deepEqual(
    changedPathsFromOutput("Success. Updated the following files:\nA one.txt\nM src/two.ts\nD old.txt\n"),
    ["one.txt", "src/two.ts", "old.txt"],
  );
});

test("extracts all source and destination paths from an apply patch", () => {
  assert.deepEqual(
    pathsFromPatch(
      "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-old\n+new\n*** Add File: added.ts\n+added\n*** End Patch",
    ),
    ["old.ts", "new.ts", "added.ts"],
  );
});

test("renders collapsed compaction status on one content line", () => {
  initTheme(undefined, false);
  installCompactCompactionRenderer();
  const component = new CompactionSummaryMessageComponent({
    role: "compactionSummary",
    summary: "opaque summary",
    tokensBefore: 244_800,
    timestamp: Date.now(),
  });
  assert.equal(component.render(100).length, 1);
  assert.match(component.render(100)[0], /\[compaction\].*Compacted from 244,800 tokens/);
});

test("apply_patch captures display-oriented diffs from actual file changes", async () => {
  let tool: any;
  const pi = {
    registerCommand() {},
    registerTool(definition: any) {
      tool = definition;
    },
    appendEntry() {},
    getActiveTools: () => [],
    setActiveTools() {},
    on() {},
    exec: (command: string, args: string[], options: { cwd: string }) =>
      run(command, args, options.cwd),
  } as unknown as ExtensionAPI;
  piCodex(pi);

  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-render-test-"));
  try {
    await writeFile(join(cwd, "hello.txt"), "hello\n");
    const result = await tool.execute(
      "call-1",
      {
        patch:
          "*** Begin Patch\n*** Update File: hello.txt\n@@\n-hello\n+hello colored diff\n*** End Patch",
      },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.deepEqual(result.details.changedPaths, ["hello.txt"]);
    assert.equal(result.details.diffs.length, 1);
    assert.equal(result.details.diffs[0].path, "hello.txt");
    assert.match(result.details.diffs[0].diff, /-1 hello/);
    assert.match(result.details.diffs[0].diff, /\+1 hello colored diff/);
    initTheme(undefined, false);
    const rendered = tool.renderResult(
      result,
      { expanded: false, isPartial: false },
      { fg: (_name: string, text: string) => text },
      { isError: false },
    );
    const renderedText = rendered.render(120).join("\n");
    assert.match(stripVTControlCharacters(renderedText), /hello colored diff/);
    assert.match(renderedText, /\u001b\[/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("swaps write tools only while a Codex model is selected", async () => {
  let active = ["read", "bash", "edit", "write"];
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const commands = new Map<string, any>();
  const fastEntries: any[] = [];
  let toolDefinition: any;
  const pi = {
    registerCommand(name: string, definition: any) {
      commands.set(name, definition);
    },
    appendEntry(customType: string, data: unknown) {
      fastEntries.push({ type: "custom", customType, data });
    },
    registerTool(definition: any) {
      toolDefinition = definition;
      active.push(definition.name);
    },
    getActiveTools: () => active,
    setActiveTools(tools: string[]) {
      active = tools;
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;

  piCodex(pi);
  const settings = SettingsManager.inMemory();
  assert.equal(toolDefinition.constrainedSampling.type, "grammar");
  assert.deepEqual(toolDefinition.parameters.required, ["patch"]);
  assert.match(toolDefinition.promptGuidelines.join("\n"), /re-read the affected region/);
  const multipartResult: any = handlers.get("tool_result")?.(
    {
      toolName: "bash",
      content: [
        { type: "text", text: "HEAD-" + "x".repeat(20_000) },
        { type: "image", data: "image", mimeType: "image/png" },
        { type: "text", text: "-TAIL" },
      ],
      details: { raw: true },
      isError: false,
    },
    { model: { provider: "openai-codex", id: "gpt-5.6-sol" } },
  );
  assert.equal(multipartResult.content.length, 3);
  assert.equal(multipartResult.content[0].type, "text");
  assert.match(multipartResult.content[0].text, /HEAD-/);
  assert.equal(multipartResult.content[1].type, "image");
  assert.equal(multipartResult.content[2].type, "text");
  assert.match(multipartResult.content[2].text, /-TAIL/);
  assert.deepEqual(multipartResult.details, { raw: true });
  const manyTextItems: any = handlers.get("tool_result")?.(
    {
      toolName: "bash",
      content: Array.from({ length: 20_000 }, () => ({
        type: "text",
        text: "x",
      })),
      details: undefined,
      isError: false,
    },
    { model: { provider: "openai-codex", id: "gpt-5.6-sol" } },
  );
  assert.ok(manyTextItems.content.length <= 10_000);

  await handlers.get("session_start")?.({}, {
    model: { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 272_000 },
    sessionManager: { getBranch: () => fastEntries },
    hasUI: false,
  });
  assert.deepEqual(active, ["read", "bash", "web_search", "apply_patch"]);
  assert.equal(CODEX_SOL_CONTEXT_WINDOW, 272_000);
  assert.equal(CODEX_SOL_AUTO_COMPACT_LIMIT, 244_800);
  assert.equal(settings.getCompactionSettings().reserveTokens, CODEX_SOL_RESERVE_TOKENS);
  assert.equal(
    shouldCompact(244_799, CODEX_SOL_CONTEXT_WINDOW, settings.getCompactionSettings()),
    false,
  );
  assert.equal(
    shouldCompact(244_800, CODEX_SOL_CONTEXT_WINDOW, settings.getCompactionSettings()),
    true,
  );
  let workingIndicator: { frames: string[]; intervalMs?: number } | undefined;
  await handlers.get("session_start")?.({}, {
    model: { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 272_000 },
    sessionManager: { getBranch: () => fastEntries },
    hasUI: true,
    ui: {
      theme: { fg: (_name: string, text: string) => text },
      setStatus() {},
      setWorkingIndicator(indicator: { frames: string[]; intervalMs?: number }) {
        workingIndicator = indicator;
      },
    },
  });
  assert.deepEqual(workingIndicator, { frames: ["●"] });
  const notices: string[] = [];
  const fastCtx = {
    model: { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 272_000 },
    sessionManager: { getBranch: () => fastEntries },
    hasUI: true,
    ui: {
      theme: { fg: (_name: string, text: string) => text },
      setStatus() {},
      notify(message: string) {
        notices.push(message);
      },
    },
  };
  const defaultFastPayload: any = {};
  handlers.get("before_provider_request")?.({ payload: defaultFastPayload }, fastCtx);
  assert.equal(defaultFastPayload.service_tier, "priority");

  await commands.get("fast").handler("off", fastCtx);
  const disabledFastPayload: any = {};
  handlers.get("before_provider_request")?.({ payload: disabledFastPayload }, fastCtx);
  assert.equal(disabledFastPayload.service_tier, undefined);
  assert.deepEqual(fastEntries.at(-1)?.data, { enabled: false });

  await commands.get("fast").handler("on", fastCtx);
  const enabledFastPayload: any = {};
  handlers.get("before_provider_request")?.({ payload: enabledFastPayload }, fastCtx);
  assert.equal(enabledFastPayload.service_tier, "priority");
  assert.match(notices.at(-1) ?? "", /enabled/);

  const spark = {
    provider: "openai-codex",
    id: "gpt-5.3-codex-spark",
    contextWindow: 128_000,
  };
  await handlers.get("model_select")?.({ model: spark }, { model: spark, hasUI: false });
  assert.equal(
    shouldCompact(115_199, 128_000, settings.getCompactionSettings()),
    false,
  );
  assert.equal(
    shouldCompact(115_200, 128_000, settings.getCompactionSettings()),
    true,
  );
  assert.equal(codexAutoCompactLimit(128_000), 115_200);

  const anthropic = {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    contextWindow: 200_000,
  };
  await handlers.get("model_select")?.(
    { model: anthropic },
    { model: anthropic, hasUI: false },
  );
  assert.deepEqual(active, ["read", "bash", "edit", "write"]);
  assert.equal(settings.getCompactionSettings().reserveTokens, 16_384);
});

test("formats the selection-friendly working ticker", () => {
  assert.equal(formatWorkingElapsed(0), "0s");
  assert.equal(formatWorkingElapsed(59_999), "59s");
  assert.equal(formatWorkingElapsed(65_000), "1m 5s");
  assert.equal(formatWorkingElapsed(3_720_000), "1h 2m");
});

test("resolves the same Responses endpoint as current OpenAI Codex compaction v2", () => {
  assert.equal(
    resolveCompactUrl("https://chatgpt.com/backend-api/codex"),
    "https://chatgpt.com/backend-api/codex/responses",
  );
  assert.equal(
    resolveCompactUrl("https://chatgpt.com/backend-api"),
    "https://chatgpt.com/backend-api/codex/responses",
  );
});

test("remote compaction requires a provider that declares the capability", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const pi = {
    registerCommand() {},
    registerTool() {},
    appendEntry() {},
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  piCodex(pi);

  let authRequested = false;
  const result = await handlers.get("session_before_compact")?.({
    preparation: {},
    signal: new AbortController().signal,
  }, {
    model: {
      id: "local-codex",
      provider: "local-responses",
      api: "openai-codex-responses",
    },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        authRequested = true;
        return { ok: false, error: "remote compaction should not run" };
      },
    },
  });

  assert.equal(result, undefined);
  assert.equal(authRequested, false);
});

test("remote compaction persists and reinstalls Codex replacement history", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const pi = {
    registerCommand() {},
    registerTool() {},
    appendEntry() {},
    getActiveTools: () => ["read", "bash", "edit", "write", "apply_patch"],
    getAllTools: () => [],
    setActiveTools() {},
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  piCodex(pi);

  const accountId = "acct_test";
  const tokenPayload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  const token = `e30.${tokenPayload}.signature`;
  const model = {
    id: "gpt-5.6-sol",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    input: ["text"],
    reasoning: true,
    thinkingLevelMap: { medium: "medium" },
    compat: { supportsOpenAIGrammarTools: true },
  };
  const replacement = [{ type: "compaction", encrypted_content: "opaque-checkpoint" }];
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_item.done", item: replacement[0] })}`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp-compact",
          usage: {
            input_tokens: 120,
            output_tokens: 30,
            total_tokens: 150,
            input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
            output_tokens_details: { reasoning_tokens: 12 },
          },
        },
      })}`,
      "data: [DONE]",
      "",
    ].join("\n");
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-codex-turn-state": "sticky" },
    });
  };

  try {
    const branch: any[] = [];
    branch.push({
      type: "message",
      id: "kept-entry",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "retained tail" }],
        timestamp: 1,
      },
    });
    const ctx = {
      model,
      thinkingLevel: "medium",
      getSystemPrompt: () => "You are Codex.",
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token, headers: {} }),
        getProviderAuth: async () => ({
          auth: { baseUrl: "http://subrouter.test/backend-api" },
          source: "test subrouter",
        }),
      },
      sessionManager: {
        getSessionId: () => "session-test",
        getBranch: () => branch,
      },
    };
    const result = await handlers.get("session_before_compact")?.({
      preparation: {
        firstKeptEntryId: "kept-entry",
        messagesToSummarize: [{ role: "user", content: "old context", timestamp: 1 }],
        turnPrefixMessages: [],
        tokensBefore: 100_000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      },
      customInstructions: undefined,
      willRetry: true,
      signal: new AbortController().signal,
    }, ctx);

    assert.equal(requestedUrl, "http://subrouter.test/backend-api/codex/responses");
    const headers = new Headers(requestedInit?.headers);
    assert.equal(headers.get("chatgpt-account-id"), accountId);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.get("x-codex-beta-features"), "remote_compaction_v2");
    const body = JSON.parse(String(requestedInit?.body));
    assert.equal(body.model, "gpt-5.6-sol");
    assert.equal(body.service_tier, CODEX_FAST_SERVICE_TIER);
    assert.equal(body.stream, true);
    assert.equal(body.instructions, "You are Codex.");
    assert.equal(body.input[0].role, "user");
    assert.deepEqual(body.input.at(-1), { type: "compaction_trigger" });

    const compaction = result.compaction;
    assert.equal(compaction.usage.input, 90);
    assert.equal(compaction.usage.output, 30);
    assert.equal(compaction.usage.cacheRead, 20);
    assert.equal(compaction.usage.cacheWrite, 10);
    assert.equal(compaction.usage.reasoning, 12);
    assert.equal(compaction.details.retainedContextItemCount, 1);
    assert.equal(compaction.details.output.at(-1).encrypted_content, "opaque-checkpoint");
    branch.push({ type: "compaction", details: compaction.details });
    const providerPayload: any = {
      input: [{
        role: "user",
        content: [{
          type: "input_text",
          text: checkpointMarker(compaction.details.checkpointId),
        }],
      }, {
        role: "user",
        content: [{ type: "input_text", text: "retained tail" }],
      }],
    };
    handlers.get("before_provider_request")?.({ payload: providerPayload }, ctx);
    assert.equal(providerPayload.service_tier, "priority");
    assert.deepEqual(
      providerPayload.input,
      [...compaction.details.output, providerPayload.input.at(-1)],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tool contracts preserve TypeBox schemas and Codex exposure metadata", () => {
  const schema = Type.Object({ value: Type.String() });
  const definition: ToolDefinition<typeof schema> = {
    name: "contract_test",
    label: "Contract Test",
    description: "Test tool",
    parameters: schema,
    async execute() {
      return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
    },
  };
  const direct = createToolContract(definition, {
    exposure: "direct",
    namespace: "test",
    search: { keywords: ["example"] },
    schemaVersion: "7",
    capabilities: ["test"],
    outputBudgetBytes: 123,
  });
  const deferred = direct.toCodexTool("deferred");
  assert.equal(deferred?.defer_loading, true);
  assert.equal(direct.isDirect(), true);
  assert.equal(direct.isAvailableInCodeMode(), true);
  const modelOnly = createToolContract(definition, {
    exposure: "direct_model_only",
  });
  assert.equal(modelOnly.isDirect(), true);
  assert.equal(modelOnly.isAvailableInCodeMode(), false);
  assert.equal(modelOnly.toCodexTool()?.defer_loading, undefined);
  assert.equal(direct.parameters, definition.parameters);
  assert.equal(direct.snapshot().schemaVersion, "7");
  assert.equal(direct.snapshot().outputBudgetBytes, 123);
  assert.equal(direct.schemaHash.length, 64);
  assert.equal(direct.toCodexTool("hidden"), undefined);

  const registry = new ToolContractRegistry();
  registry.register(definition, { exposure: "deferred" });
  assert.deepEqual(registry.toCodexTools(), []);
  assert.equal(registry.toCodexTools({ includeDeferred: true })[0].defer_loading, true);
  assert.equal(fingerprintToolCatalog(registry.values()), registry.fingerprint());
  assert.throws(
    () => registry.register(definition),
    /already registered/,
  );
});

test("Codex output truncation is model-facing only and preserves both ends", () => {
  const input = `HEAD-${"x".repeat(20_000)}-TAIL`;
  const result = truncateCodexOutput(input);
  assert.equal(CODEX_DEFAULT_OUTPUT_BUDGET_BYTES, 10_000);
  assert.equal(result.truncated, true);
  assert.match(result.content, /Warning: truncated output/);
  assert.match(result.content, /Total output lines: 1/);
  assert.match(result.content, /HEAD-/);
  assert.match(result.content, /-TAIL$/);
  assert.match(result.content, /chars truncated/);
  assert.equal(truncateCodexOutput("short").content, "short");
  assert.equal(
    truncateCodexText("0123456789", { type: "bytes", limit: 4 }),
    "01…6 chars truncated…89",
  );
  assert.match(
    formatCodexTruncatedOutput("a\n", { type: "bytes", limit: 1 }).content,
    /Total output lines: 1/,
  );
  const unicode = truncateCodexOutput("🙂".repeat(20), 10);
  assert.equal(unicode.truncated, true);
  assert.doesNotThrow(() => JSON.stringify(unicode.content));
});

test("compaction preserves Codex tool wire modalities and deferred exposure", () => {
  const schema = Type.Object({ query: Type.String() });
  const body = buildCompactRequest({
    model: {
      id: "gpt-5.6-sol",
      compat: { supportsStrictMode: true, supportsOpenAIGrammarTools: false },
      thinkingLevelMap: {},
      input: ["text"],
    } as never,
    messages: [] as never,
    instructions: "system",
    tools: [
      {
        name: "deferred_search",
        description: "Search",
        parameters: schema,
        defer_loading: true,
      },
    ],
  });
  assert.equal((body.tools as any[])[0].type, "function");
  assert.equal((body.tools as any[])[0].defer_loading, true);
  assert.equal((body.tools as any[])[0].strict, null);
});

test("compaction omits legacy function item ids when replaying custom tools", () => {
  const callId = "call_NN4c5V7Onkj6YcXCXgijxyEs";
  const legacyItemId =
    "fc_01656a69efc78cad016a7d50b9d1f4819ba33c01fdfcd6bf52";
  const toolCallId = `${callId}|${legacyItemId}`;
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  const body = buildCompactRequest({
    model: {
      id: "gpt-5.6-sol",
      provider: "subrouter",
      api: "openai-codex-responses",
      input: ["text"],
      reasoning: true,
      compat: { supportsOpenAIGrammarTools: true },
    } as never,
    messages: [
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: toolCallId,
          name: "apply_patch",
          arguments: { patch: "*** Begin Patch\n*** End Patch" },
        }],
        api: "openai-codex-responses",
        provider: "subrouter",
        model: "gpt-5.5",
        usage,
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId,
        toolName: "apply_patch",
        content: [{ type: "text", text: "Done" }],
        isError: false,
        timestamp: 2,
      },
    ] as never,
    instructions: "system",
  });

  const customCall = body.input.find(
    (item) => item.type === "custom_tool_call",
  );
  assert.ok(customCall);
  assert.equal("id" in customCall, false);
  assert.equal(customCall.call_id, callId);
  assert.ok(body.input.some(
    (item) =>
      item.type === "custom_tool_call_output" &&
      item.call_id === callId,
  ));
});

test("replacement history retains bounded assistant and oversized text messages", () => {
  const compacted = { type: "compaction", encrypted_content: "opaque" };
  const assistant = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "intermediate answer" }],
  };
  assert.deepEqual(
    buildReplacementHistory(
      [assistant, { type: "compaction_trigger" }],
      compacted,
    ),
    [assistant, compacted],
  );

  const oversized = {
    type: "message",
    role: "user",
    content: "x".repeat(300_000),
  };
  const retained = buildReplacementHistory(
    [oversized, { type: "compaction_trigger" }],
    compacted,
  );
  assert.equal(retained.length, 2);
  assert.equal(retained[0].role, "user");
  assert.equal(typeof retained[0].content, "string");
  assert.match(retained[0].content as string, /truncated/);
  assert.ok(
    Math.ceil(Buffer.byteLength(JSON.stringify(retained[0]), "utf8") / 4) <=
      64_000,
  );

  const multipart = {
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: "x".repeat(300_000),
    }, {
      type: "input_text",
      text: "later text",
    }],
  };
  const multipartRetained = buildReplacementHistory(
    [multipart, { type: "compaction_trigger" }],
    compacted,
  );
  assert.ok(Array.isArray(multipartRetained[0].content));
  assert.ok((multipartRetained[0].content as any[]).every(
    (item) => item.type !== "input_text" || typeof item.text === "string",
  ));
});

test("replacement history does not let non-text content bypass its budget", () => {
  const compacted = { type: "compaction", encrypted_content: "opaque" };
  const oversizedImage = {
    type: "message",
    role: "user",
    content: [{
      type: "input_image",
      image_url: `data:image/png;base64,${"a".repeat(300_000)}`,
    }, {
      type: "input_text",
      text: "caption",
    }],
  };

  assert.deepEqual(
    buildReplacementHistory(
      [oversizedImage, { type: "compaction_trigger" }],
      compacted,
    ),
    [compacted],
  );
});

test("remote compaction checkpoints parse, replay, and safely ignore stale input", () => {
  const compacted = { type: "compaction", encrypted_content: "opaque" };
  const parsed = parseRemoteCompactionSse([
    `data: ${JSON.stringify({ type: "response.output_item.done", item: compacted })}`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "response-1" } })}`,
  ].join("\n"));
  assert.deepEqual(parsed, { compaction: compacted, responseId: "response-1" });
  const checkpointInput = [
    { role: "user", content: [{ type: "input_text", text: checkpointMarker("cp-1") }] },
  ];
  const details = {
    type: "pi-codex-remote-compaction" as const,
    version: 2 as const,
    checkpointId: "cp-1",
    endpoint: "https://example.test",
    output: [compacted],
    readFiles: [],
    modifiedFiles: [],
    toolCatalogFingerprint: "catalog-1",
    contextFingerprint: fingerprintCheckpointInput(
      checkpointInput,
      checkpointMarker("cp-1"),
    ),
  };
  assert.equal(isRemoteCompactionDetails(details), true);
  assert.equal(
    isRemoteCompactionDetails({ ...details, version: 1 }),
    true,
    "legacy Subrouter checkpoints remain readable",
  );
  const payload: any = { input: checkpointInput };
  const suffix = [{ type: "message", role: "user", content: [{ type: "input_text", text: "tail" }] }];
  const suffixPayload: any = {
    input: [...checkpointInput, ...suffix],
  };
  const suffixFingerprint = fingerprintCheckpointSuffix(
    suffixPayload.input,
    checkpointMarker("cp-1"),
    1,
  );
  assert.ok(suffixFingerprint);
  const mismatchedSuffix: any = {
    input: [
      ...checkpointInput,
      { type: "message", role: "user", content: [{ type: "input_text", text: "changed" }] },
    ],
  };
  installRemoteCheckpoint(mismatchedSuffix, {
    ...details,
    contextFingerprint: suffixFingerprint,
    retainedContextItemCount: 1,
  }, {
    toolCatalogFingerprint: "catalog-1",
    contextFingerprint: fingerprintCheckpointSuffix(
      mismatchedSuffix.input,
      checkpointMarker("cp-1"),
      1,
    ),
  });
  assert.match(JSON.stringify(mismatchedSuffix), /changed/);
  installRemoteCheckpoint(payload, details, {
    toolCatalogFingerprint: "catalog-1",
    contextFingerprint: fingerprintCheckpointInput(payload.input, checkpointMarker("cp-1")),
  });
  assert.deepEqual(payload.input, details.output);
  const stale: any = {
    input: [{ role: "user", content: [{ type: "input_text", text: checkpointMarker("cp-1") }] }],
  };
  installRemoteCheckpoint(stale, details, { toolCatalogFingerprint: "catalog-2" });
  assert.match(JSON.stringify(stale), /cp-1/);
  const unrelated: any = { input: [{ role: "user", content: "new request" }] };
  installRemoteCheckpoint(unrelated, details);
  assert.deepEqual(unrelated.input, [{ role: "user", content: "new request" }]);

  const retained = buildReplacementHistory(
    [{ role: "user", content: "first" }, { role: "assistant", content: "answer" }, { type: "function_call", role: "assistant" }, { type: "compaction_trigger" }],
    compacted,
  );
  assert.deepEqual(retained.map((item) => item.content ?? item.type), ["first", "compaction"]);
});

test("official Codex binary applies add and update hunks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-test-"));
  try {
    const add = await run(
      resolveCodexExecutable(),
      [
        CODEX_APPLY_PATCH_FLAG,
        "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch",
      ],
      cwd,
    );
    assert.equal(add.code, 0, add.stderr);
    assert.equal(await readFile(join(cwd, "hello.txt"), "utf8"), "hello\n");

    const update = await run(
      resolveCodexExecutable(),
      [
        CODEX_APPLY_PATCH_FLAG,
        "*** Begin Patch\n*** Update File: hello.txt\n@@\n-hello\n+hello from Codex\n*** End Patch",
      ],
      cwd,
    );
    assert.equal(update.code, 0, update.stderr);
    assert.equal(await readFile(join(cwd, "hello.txt"), "utf8"), "hello from Codex\n");

    await writeFile(
      join(cwd, "hello.txt"),
      "\tfunction example() {\n\t\treturn \"old\";\n\t}\n",
    );
    const whitespaceFuzzy = await run(
      resolveCodexExecutable(),
      [
        CODEX_APPLY_PATCH_FLAG,
        "*** Begin Patch\n*** Update File: hello.txt\n@@\n function example() {\n-\treturn \"old\";\n+\treturn \"new\";\n }\n*** End Patch",
      ],
      cwd,
    );
    assert.equal(whitespaceFuzzy.code, 0, whitespaceFuzzy.stderr);
    assert.equal(
      await readFile(join(cwd, "hello.txt"), "utf8"),
      "function example() {\n\treturn \"new\";\n}\n",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
