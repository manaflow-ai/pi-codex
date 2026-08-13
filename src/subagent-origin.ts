/**
 * Machine-readable origin contract shared by pi-codex child processes and the
 * cmux Pi session hook. Keep this independent of Pi internals so both sides
 * can classify activity before rendering or notification policy is applied.
 */

export const PI_CODEX_SUBAGENT_ENV = "PI_CODEX_SUBAGENT";
export const PI_CODEX_SUBAGENT_MARKER = "pi-codex-subagent-v1";
export const CMUX_ACTIVITY_ORIGIN_KEY = "cmux_activity_origin";
export const SUBAGENT_ACTIVITY_ORIGIN = "subagent";
export const PARENT_ACTIVITY_ORIGIN = "parent";

export type ActivityOrigin = typeof SUBAGENT_ACTIVITY_ORIGIN | typeof PARENT_ACTIVITY_ORIGIN;

export interface SubagentActivityDetails {
  [CMUX_ACTIVITY_ORIGIN_KEY]: typeof SUBAGENT_ACTIVITY_ORIGIN;
  marker: typeof PI_CODEX_SUBAGENT_MARKER;
}

export function subagentEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    [PI_CODEX_SUBAGENT_ENV]: PI_CODEX_SUBAGENT_MARKER,
  };
}

export function subagentActivityDetails(): SubagentActivityDetails {
  return {
    [CMUX_ACTIVITY_ORIGIN_KEY]: SUBAGENT_ACTIVITY_ORIGIN,
    marker: PI_CODEX_SUBAGENT_MARKER,
  };
}

function valueAt(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function hasSubagentMarker(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const origin = valueAt(value, [
    CMUX_ACTIVITY_ORIGIN_KEY,
    "cmuxActivityOrigin",
    "origin",
  ]);
  if (origin === SUBAGENT_ACTIVITY_ORIGIN) return true;
  const marker = valueAt(value, ["marker", "cmux_marker", "cmuxMarker"]);
  return marker === PI_CODEX_SUBAGENT_MARKER;
}

/**
 * Classify a Pi lifecycle event. The process marker is authoritative for a
 * child process; event and custom-message metadata cover parent-process
 * subagent implementations that report their child work inline.
 */
export function classifyActivityOrigin(
  event: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): ActivityOrigin {
  if (environment[PI_CODEX_SUBAGENT_ENV] === PI_CODEX_SUBAGENT_MARKER) {
    return SUBAGENT_ACTIVITY_ORIGIN;
  }
  if (hasSubagentMarker(event)) return SUBAGENT_ACTIVITY_ORIGIN;
  if (
    valueAt(event, ["role"]) === "custom" &&
    hasSubagentMarker(valueAt(event, ["details"]))
  ) {
    return SUBAGENT_ACTIVITY_ORIGIN;
  }

  const messages = valueAt(event, ["messages"]);
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (hasSubagentMarker(message)) return SUBAGENT_ACTIVITY_ORIGIN;
      if (
        valueAt(message, ["role"]) === "custom" &&
        hasSubagentMarker(valueAt(message, ["details"]))
      ) {
        return SUBAGENT_ACTIVITY_ORIGIN;
      }
    }
  }
  return PARENT_ACTIVITY_ORIGIN;
}

export function shouldRouteCompletionNotification(origin: ActivityOrigin): boolean {
  return origin === PARENT_ACTIVITY_ORIGIN;
}
