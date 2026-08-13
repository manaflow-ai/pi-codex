const codingAgentEntryUrl = import.meta.resolve(
  "@earendil-works/pi-coding-agent",
);
const statusIndicatorUrl = new URL(
  "./modes/interactive/components/status-indicator.js",
  codingAgentEntryUrl,
).href;
const { CompactionStatusIndicator } = await import(statusIndicatorUrl);

const elapsedRendererMarker: unique symbol = Symbol.for(
  "pi-codex.compaction-elapsed-renderer.v1",
) as never;

interface ElapsedState {
  startedAt: number;
  baseMessage: string;
  renderedSeconds?: number;
}

interface PatchableCompactionStatus {
  [elapsedRendererMarker]?: true;
  message: string;
  render(width: number): string[];
  setMessage(message: string): void;
}

const elapsedStates = new WeakMap<object, ElapsedState>();

export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function withElapsedTime(message: string, elapsedMs: number): string {
  const elapsed = `${formatElapsed(elapsedMs)} elapsed`;
  const cancelHint = message.match(/\s(\([^)]*to cancel\))$/u)?.[1];
  if (!cancelHint) return `${message} ${elapsed}`;
  return `${message.slice(0, -cancelHint.length).trimEnd()} ${elapsed} ${cancelHint}`;
}

export function installCompactionElapsedRenderer(): void {
  const prototype =
    CompactionStatusIndicator.prototype as PatchableCompactionStatus;
  if (prototype[elapsedRendererMarker]) return;

  const original = prototype.render;
  prototype.render = function (width: number): string[] {
    let elapsedState = elapsedStates.get(this);
    if (!elapsedState) {
      elapsedState = {
        startedAt: Date.now(),
        baseMessage: this.message,
      };
      elapsedStates.set(this, elapsedState);
    }

    const elapsedMs = Date.now() - elapsedState.startedAt;
    const elapsedSeconds = Math.floor(elapsedMs / 1_000);
    if (elapsedSeconds !== elapsedState.renderedSeconds) {
      elapsedState.renderedSeconds = elapsedSeconds;
      this.setMessage(
        withElapsedTime(elapsedState.baseMessage, elapsedMs),
      );
    }
    return original.call(this, width);
  };
  Object.defineProperty(prototype, elapsedRendererMarker, { value: true });
}

export { CompactionStatusIndicator };
