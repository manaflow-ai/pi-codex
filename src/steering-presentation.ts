import type { UserMessage } from "@earendil-works/pi-ai";
import {
  InteractiveMode,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";

const STEERING_INSTRUCTION = [
  "Treat this as an update to the current task.",
  "Only abandon, stop, or replace the previous work if this message explicitly requests that.",
].join("\n");
const STEERING_DIRECTIVE = [
  "<steering-message>",
  STEERING_INSTRUCTION,
  "</steering-message>",
].join("\n");
const LEGACY_STEERING_PREFIX = [
  "<steering-message>",
  STEERING_INSTRUCTION,
  "",
].join("\n");
const STEERING_SUFFIX = "\n</steering-message>";
const MESSAGE_PREFIX = "<message>\n";
const MESSAGE_SUFFIX = "\n</message>";
const WRAPPER_BOUNDARY = "\u0000pi-codex-steering-boundary\u0000";
const MAX_TRACKED_MESSAGES = 500;
const PREVIEW_LENGTH = 100;

const rendererMarker: unique symbol = Symbol.for(
  "pi-codex.steering-message-renderer.v1",
) as never;
const stateKey = Symbol.for("pi-codex.steering-message-state.v1");

interface SteeringState {
  pending: string[];
  knownMessages: Set<string>;
}

interface RuntimeGlobal {
  [stateKey]?: SteeringState;
}

interface MessageLike {
  role: string;
  content?: unknown;
  timestamp?: number;
}

interface PatchableUserMessageComponent {
  text: string;
  rebuild(): void;
}

interface PatchableInteractiveMode {
  [rendererMarker]?: true;
  addMessageToChat(
    message: MessageLike,
    options?: { populateHistory?: boolean },
  ): void;
  updatePendingMessagesDisplay(): void;
}

interface InteractiveModeInstance {
  chatContainer: { children: unknown[] };
  pendingMessagesContainer: { children: unknown[] };
  toolOutputExpanded: boolean;
  getAllQueuedMessages(): { steering: string[]; followUp: string[] };
}

interface PatchableTruncatedText {
  text: string;
}

function state(): SteeringState {
  const runtime = globalThis as RuntimeGlobal;
  runtime[stateKey] ??= {
    pending: [],
    knownMessages: new Set(),
  };
  return runtime[stateKey];
}

function textFromMessage(message: MessageLike): string | undefined {
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n");
  return text || undefined;
}

function messageKey(message: MessageLike): string | undefined {
  const text = textFromMessage(message);
  if (text === undefined || typeof message.timestamp !== "number") return undefined;
  return `${message.timestamp}\u0000${text}`;
}

function pruneKnownMessages(knownMessages: Set<string>): void {
  while (knownMessages.size > MAX_TRACKED_MESSAGES) {
    const oldest = knownMessages.values().next().value;
    if (oldest === undefined) break;
    knownMessages.delete(oldest);
  }
}

function normalizedPreview(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= PREVIEW_LENGTH) return normalized;
  return `${normalized.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…`;
}

function countOccurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

function steeringPayload(text: string): string | undefined {
  const directiveCount = countOccurrences(text, STEERING_DIRECTIVE);
  let remainder = text.replaceAll(STEERING_DIRECTIVE, "");
  const legacyPrefixCount = countOccurrences(remainder, LEGACY_STEERING_PREFIX);
  if (directiveCount === 0 && legacyPrefixCount === 0) return undefined;

  const messagePrefixCount = countOccurrences(remainder, MESSAGE_PREFIX);
  const messageSuffixCount = countOccurrences(remainder, MESSAGE_SUFFIX);
  if (
    messagePrefixCount !== directiveCount ||
    messageSuffixCount !== directiveCount
  ) {
    return undefined;
  }

  remainder = remainder
    .replaceAll(MESSAGE_PREFIX, "")
    .replaceAll(MESSAGE_SUFFIX, WRAPPER_BOUNDARY);
  const remainingLegacyPrefixCount = countOccurrences(
    remainder,
    LEGACY_STEERING_PREFIX,
  );
  const legacySuffixCount = countOccurrences(remainder, STEERING_SUFFIX);
  if (
    remainingLegacyPrefixCount !== legacyPrefixCount ||
    legacySuffixCount !== legacyPrefixCount
  ) {
    return undefined;
  }

  remainder = remainder
    .replaceAll(LEGACY_STEERING_PREFIX, "")
    .replaceAll(STEERING_SUFFIX, WRAPPER_BOUNDARY);
  if (
    remainder.includes(STEERING_DIRECTIVE) ||
    remainder.includes(LEGACY_STEERING_PREFIX) ||
    remainder.includes(MESSAGE_PREFIX) ||
    remainder.includes(MESSAGE_SUFFIX)
  ) {
    return undefined;
  }

  return remainder
    .split(WRAPPER_BOUNDARY)
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

function formatSteeringMessage(text: string): string {
  return [
    STEERING_DIRECTIVE,
    "",
    "<message>",
    text,
    "</message>",
  ].join("\n");
}

function steeringGroupMarkdown(messages: readonly string[], expanded: boolean): string {
  if (messages.length === 1) {
    return `**Steering update**\n\n${messages[0]}`;
  }
  if (!expanded) {
    return `**${messages.length} steering updates**\n\n${normalizedPreview(messages.at(-1) ?? "")}`;
  }
  return [
    `**${messages.length} steering updates**`,
    ...messages.map((message, index) => `${index + 1}. ${message}`),
  ].join("\n\n");
}

class SteeringMessageGroupComponent extends UserMessageComponent {
  private readonly messages: string[];
  private expanded = false;

  constructor(message: string) {
    super(steeringGroupMarkdown([message], false));
    this.messages = [message];
  }

  addMessage(message: string): void {
    this.messages.push(message);
    this.refresh();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.refresh();
  }

  private refresh(): void {
    const component = this as unknown as PatchableUserMessageComponent;
    component.text = steeringGroupMarkdown(this.messages, this.expanded);
    component.rebuild();
  }
}

export function collapseRenderedSteeringMessage(
  children: unknown[],
  message: string,
  expanded: boolean,
): void {
  const added = children.at(-1);
  if (!(added instanceof UserMessageComponent)) return;

  const previous = children.at(-3);
  if (previous instanceof SteeringMessageGroupComponent) {
    previous.addMessage(message);
    children.splice(-2, 2);
    return;
  }

  const group = new SteeringMessageGroupComponent(message);
  group.setExpanded(expanded);
  children[children.length - 1] = group;
}

export function collapsePendingSteeringRows(
  children: unknown[],
  steeringMessages: readonly string[],
): void {
  if (steeringMessages.length < 2 || children.length < steeringMessages.length + 2) {
    return;
  }

  const firstRow = children[1] as PatchableTruncatedText | undefined;
  if (!firstRow || typeof firstRow.text !== "string") return;
  const originalLabel = `Steering: ${steeringMessages[0]}`;
  if (!firstRow.text.includes(originalLabel)) return;

  firstRow.text = firstRow.text.replace(
    originalLabel,
    `Steering (${steeringMessages.length}): ${normalizedPreview(steeringMessages.at(-1) ?? "")}`,
  );
  children.splice(2, steeringMessages.length - 1);
}

function isKnownSteeringMessage(message: MessageLike): boolean {
  const key = messageKey(message);
  return key !== undefined && state().knownMessages.has(key);
}

export function continueAfterSteeringMessage(text: string): string {
  return formatSteeringMessage(steeringPayload(text) ?? text);
}

export function collapseSteeringMessages(text: string): string {
  const payload = steeringPayload(text);
  return payload === undefined ? text : formatSteeringMessage(payload);
}

export function steeringDisplayText(text: string): string {
  return steeringPayload(text) ?? text;
}

export function resetSteeringPresentation(): void {
  state().pending = [];
  state().knownMessages.clear();
}

export function trackSteeringInput(text: string): void {
  state().pending.push(text);
}

export function clearPendingSteeringInputs(): void {
  state().pending = [];
}

export function markDeliveredSteeringMessage(message: MessageLike): boolean {
  const text = textFromMessage(message);
  const key = messageKey(message);
  if (text === undefined || key === undefined) return false;

  const current = state();
  const pendingIndex = current.pending.indexOf(text);
  if (pendingIndex === -1) return false;
  current.pending.splice(pendingIndex, 1);
  current.knownMessages.add(key);
  pruneKnownMessages(current.knownMessages);
  return true;
}

function wrapKnownSteeringRun(messages: MessageLike[]): UserMessage {
  const text = messages
    .map((message) => textFromMessage(message))
    .filter((value): value is string => value !== undefined)
    .join("\n\n");
  const images = messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (item as { type?: unknown }).type === "image",
        )
      : [],
  );
  return {
    role: "user",
    content: [
      { type: "text", text: continueAfterSteeringMessage(text) },
      ...images,
    ] as UserMessage["content"],
    timestamp: messages[0].timestamp ?? Date.now(),
  };
}

function collapseLegacySteeringMessage(message: MessageLike): MessageLike {
  if (message.role !== "user") return message;
  if (typeof message.content === "string") {
    const content = collapseSteeringMessages(message.content);
    return content === message.content ? message : { ...message, content };
  }
  if (!Array.isArray(message.content)) return message;

  let changed = false;
  const content = message.content.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      (item as { type?: unknown }).type !== "text" ||
      typeof (item as { text?: unknown }).text !== "string"
    ) {
      return item;
    }
    const text = collapseSteeringMessages((item as { text: string }).text);
    if (text === (item as { text: string }).text) return item;
    changed = true;
    return { ...item, text };
  });
  return changed ? { ...message, content } : message;
}

export function transformSteeringContext<T extends MessageLike>(
  messages: readonly T[],
): T[] {
  const transformed: MessageLike[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!isKnownSteeringMessage(message)) {
      transformed.push(collapseLegacySteeringMessage(message));
      continue;
    }

    const run: MessageLike[] = [message];
    while (
      index + 1 < messages.length &&
      isKnownSteeringMessage(messages[index + 1])
    ) {
      run.push(messages[++index]);
    }
    transformed.push(wrapKnownSteeringRun(run));
  }
  return transformed as T[];
}

export function installSteeringMessageRenderer(): void {
  const prototype =
    InteractiveMode.prototype as unknown as PatchableInteractiveMode;
  if (prototype[rendererMarker]) return;

  const originalAddMessage = prototype.addMessageToChat;
  prototype.addMessageToChat = function (
    this: InteractiveModeInstance,
    message,
    options,
  ) {
    originalAddMessage.call(this, message, options);
    if (!isKnownSteeringMessage(message)) return;
    collapseRenderedSteeringMessage(
      this.chatContainer.children,
      textFromMessage(message) ?? "",
      this.toolOutputExpanded,
    );
  };

  const originalUpdatePending = prototype.updatePendingMessagesDisplay;
  prototype.updatePendingMessagesDisplay = function (
    this: InteractiveModeInstance,
  ) {
    originalUpdatePending.call(this);
    collapsePendingSteeringRows(
      this.pendingMessagesContainer.children,
      this.getAllQueuedMessages().steering,
    );
  };
  Object.defineProperty(prototype, rendererMarker, { value: true });
}

export { SteeringMessageGroupComponent };
