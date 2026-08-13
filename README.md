# pi-codex

A [pi](https://pi.dev) package from [Manaflow](https://github.com/manaflow-ai)
that gives Codex models OpenAI Codex's native `apply_patch` and web search tools.

When the selected model uses the `openai-codex` provider, or its model ID contains `codex`, the extension replaces active `edit` and `write` tools with `apply_patch`. Switching to a non-Codex model restores the tools it removed.

## Install

Install [pi](https://pi.dev), then install this package directly from GitHub:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install git:github.com/manaflow-ai/pi-codex
pi
```

Use `/login` to authenticate with ChatGPT, then select an `openai-codex` model
with `/model`. To pin this release instead of following the default
branch:

```bash
pi install git:github.com/manaflow-ai/pi-codex@v0.1.1
```

> The unscoped `pi-codex` package on npm is an unrelated project. Install this
> package from GitHub as shown above.

Pi packages execute code with your user permissions. Review the source before
installing it.

## Why the Codex dependency?

The model-facing tool does not require a provider workaround. Pi supports OpenAI custom/freeform tools with Lark grammars, and pi's Codex model catalog enables that capability.

Applying a patch correctly is separate. This package pins `@openai/codex` and invokes its native binary's internal `apply_patch` entrypoint, so parsing, fuzzy context matching, file moves, errors, and output match the upstream implementation instead of a partial TypeScript rewrite.

## Launcher

The package also includes a `pi-codex` launcher that loads the extension for
one run and defaults pi to the `openai-codex` provider. Install it from a
checkout:

```bash
git clone https://github.com/manaflow-ai/pi-codex.git
cd pi-codex
npm install
npm link
pi-codex
```

The launcher loads this package and defaults pi to the `openai-codex` provider. Normal pi arguments work:

```bash
pi-codex --model gpt-5.6-sol:high
pi-codex --model openai/gpt-5.3-codex
```

To install only the extension into pi without the launcher:

```bash
pi install git:github.com/manaflow-ai/pi-codex
```

The native Codex package is large because it includes the platform binary.

## Behavior

- Treats steering interruptions as updates to the current task for every model,
  continuing prior work unless the steering message explicitly says to stop or
  replace it.
- Uses the upstream freeform patch format and Lark grammar.
- Keeps each registered tool's TypeBox schema, exposure, execution mode,
  capabilities, and output budget in one Codex tool contract. Remote
  compaction sends the same direct model-visible schema projection as the
  active Pi tools, while preserving deferred-loading metadata for discovery.
- Supports add, update, move, and delete hunks.
- Executes patches sequentially relative to other tool calls.
- Respects tool selection: if `apply_patch` was excluded initially, `edit` and `write` are not replaced.
- Falls back to pi's normal `edit` and `write` tools after switching away from a Codex model.
- Enables Codex's standalone live `web_search` tool for the `openai-codex` provider and renders its calls and results as normal Pi tool rows.
- Sends standalone search to the resolved Codex `/alpha/search` endpoint, preserving provider base URL and header overrides, including cmux subrouters.
- Uses current Codex remote compaction V2 for the `openai-codex` provider.
- Applies Codex's model-facing middle-output truncation policy to package
  tools and the `tool_result` boundary, while retaining raw search output and
  patch details for rendering and inspection. Structured non-text result
  content remains attached to the truncated model-facing result.
- Requests Codex Fast mode (`service_tier: "priority"`) for models that advertise the Fast tier, including normal turns and remote-compaction turns.
- Renders successful `apply_patch` results as pi-native colored diffs generated from the actual before/after files.
- Collapses the normal compaction notice to one line; `Ctrl+O` still expands its summary.
- Uses a static working indicator with a once-per-second elapsed-time label
  (`Working (12s)`, `Working (1m 5s)`) instead of Pi's selection-hostile 80 ms
  spinner, while preserving the normal working row and every extension.

## Contextual cmux titles

When Pi runs in a cmux terminal, the package names the caller's exact tab and workspace after every user message. It snapshots the active session branch and starts a no-tool Pi subagent against that fork, so the tab title can use the full conversation rather than only the latest prompt.

The same naming pass also produces a whole-session TL;DR and a compact, chronological summary of the last three substantive user prompts. It publishes both on Pi's extension event bus as `cmux-tab-title:request-timeline`. The latest-request widget also shows the latest prompt unchanged when it is short, or as an extractive, ellipsis-separated abridgment when it looks like pasted or lengthy material.

For the workspace title, the extension makes one `cmux tree --workspace …` query. Despite the command name, this is scoped to the caller's current workspace rather than the whole cmux tree. The subagent receives a bounded, ID-free inventory of that workspace's surface titles, types, and URLs, then chooses a broader name representing the workspace as a whole. It does not run `cmux top` or enumerate processes. Titles are limited to 40 characters and applied with `cmux rename-tab` and `cmux workspace rename`; session IDs are never appended. A quick prompt-based tab title is applied while the subagent runs.

Workspace renames are coordinated across every Pi process in that workspace. Each request atomically claims the workspace using a socket-and-workspace-scoped file lock; the generated name is applied only if that claim is still newest, and the ownership check plus `cmux workspace rename` run under the same lock. This prevents a slower naming call from another terminal from overwriting a newer workspace name.

Naming always uses `openai-codex/gpt-5.6-luna` at `medium` thinking, independent of the model selected in the parent Pi session.

All cmux inspection and rename work is scheduled after Pi's message event returns. Inventory commands and the naming fork run asynchronously, while rename commands are detached and unreferenced so title updates never block the parent agent.

Synthetic `<background-job-notification>` and `<background-monitor-notification>` turns are ignored, so background delivery does not spend a Luna call, cancel an in-flight naming run, or replace a useful title. If a notification is accompanied by user-authored text, the turn is still named normally.

The integration is inert outside interactive Pi sessions in cmux. Set `PI_CMUX_TAB_TITLE_DEBUG=1` to log background title-generation failures.

## Remote compaction

Current OpenAI Codex enables `RemoteCompactionV2` by default. `pi-codex` mirrors that flow:

1. Sends a streaming request to the resolved Codex provider base URL plus `/codex/responses` (normally `https://chatgpt.com/backend-api/codex/responses`), the same route as normal turns. Auth-provided base URL overrides, including cmux subrouters, are honored.
2. Appends `{ "type": "compaction_trigger" }` to the Responses input.
3. Requires exactly one `{ "type": "compaction" }` output item.
4. Persists the opaque replacement history in pi's compaction entry and reinstalls it verbatim in later Codex requests, including after resume.
5. Stores the response ID, token usage, tool-catalog fingerprint, retained
   suffix fingerprint, and checkpoint version with the replacement history. A
   v2 checkpoint is replayed only when its marker, active tool catalog, and
   retained suffix still match; legacy v1 entries remain readable.
6. Replays `x-codex-turn-state` only within the active Pi turn, including an
   immediate overflow retry.

For every model under the `openai-codex` provider, `pi-codex` matches Codex's default automatic-compaction boundary at 90% of that model's context window. For example, the live 272,000-token models compact beginning at 244,800 tokens, while the 128,000-token Spark model begins at 115,200. Internally the pi reserve includes one extra token because pi's comparison is `>` while Codex's is `>=`. The override is in-memory, applies only while an `openai-codex` model is selected, preserves an explicit `compaction.enabled: false`, and does not rewrite `settings.json` or affect other providers.

The older `/codex/responses/compact` endpoint remains in Codex for the legacy implementation, but it is not the default in the inspected upstream revision. There is no additional compaction-specific subrouter path: both normal and compaction V2 traffic use the resolved base URL's `/backend-api/codex/responses` route.

Remote compaction is intentionally limited to the `openai-codex` provider. Other providers retain pi's normal local summary compaction.

The package targets Pi 0.84 APIs. It does not attempt to reproduce Codex's
subagent tool surface yet. First-class namespace routing, model-owned tool
search dispatch, and provider response continuation remain Pi core concerns.
Deferred contracts therefore stay out of the initial model-visible tool list,
matching Codex's `model_visible_specs()` projection, while their schemas remain
available to the tool-search lifecycle and checkpoint fingerprint.

## Fast mode

Fast mode defaults to on for supported `openai-codex` models. Use:

```text
/fast          # toggle
/fast on
/fast off
/fast status
```

The selection is stored in the session, survives `/reload` and resume, and resets to on for a new session. Unsupported models and non-Codex providers ignore the tier selection.

## Development

```bash
npm install
npm run check
npm test
```

The upstream grammar is copied from `codex-rs/core/src/tools/handlers/apply_patch.lark` in `openai/codex`. See `THIRD_PARTY_NOTICES.md`.
