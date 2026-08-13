import { createHash } from "node:crypto";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * This is the package-level equivalent of Codex's ToolExposure enum.
 *
 * Pi owns the actual dispatch and tool-search lifecycle. The contract keeps
 * the model-facing specification, execution metadata, and exposure decision
 * together so compaction requests cannot silently drift from registered tools.
 */
export type CodexToolExposure =
  | "direct"
  | "deferred"
  | "direct_model_only"
  | "hidden";

export type CodexToolParallelism = "parallel" | "sequential";

export interface CodexToolSearchMetadata {
  namespace?: string;
  keywords?: string[];
  text?: string;
}

export interface CodexToolContractMetadata {
  exposure?: CodexToolExposure;
  namespace?: string;
  search?: CodexToolSearchMetadata;
  schemaVersion?: string;
  capabilities?: string[];
  parallelism?: CodexToolParallelism;
  outputBudgetBytes?: number;
}

export interface CodexToolSpec {
  name: string;
  description: string;
  parameters: TSchema;
  constrainedSampling?: unknown;
  defer_loading?: boolean;
}

export interface CodexToolContractSnapshot {
  name: string;
  description: string;
  exposure: CodexToolExposure;
  namespace?: string;
  search?: CodexToolSearchMetadata;
  schemaVersion: string;
  schemaHash: string;
  parallelism: CodexToolParallelism;
  capabilities: string[];
  outputBudgetBytes: number;
  spec: CodexToolSpec;
}

export interface CodexToolContract<TParams extends TSchema = TSchema> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParams;
  readonly definition: ToolDefinition<TParams, any, any>;
  readonly exposure: CodexToolExposure;
  readonly namespace?: string;
  readonly search?: CodexToolSearchMetadata;
  readonly schemaVersion: string;
  readonly schemaHash: string;
  readonly parallelism: CodexToolParallelism;
  readonly capabilities: readonly string[];
  readonly outputBudgetBytes: number;
  /** Whether the executor may run alongside another tool call. */
  readonly supportsParallelToolCalls: boolean;
  /** True for tools visible in the initial model tool list. */
  isDirect(): boolean;
  /** True for tools that may be made available to a nested code surface. */
  isAvailableInCodeMode(): boolean;
  toCodexTool(exposure?: CodexToolExposure): CodexToolSpec | undefined;
  snapshot(): CodexToolContractSnapshot;
}

export const DEFAULT_OUTPUT_BUDGET_BYTES = 10_000;
const DEFAULT_SCHEMA_VERSION = "1";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function schemaHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/** Hash the exact provider-facing tool specs, independent of registration order. */
export function fingerprintToolSpecs(tools: readonly unknown[]): string {
  const ordered = [...tools].sort((left, right) => {
    const leftName = typeof left === "object" && left ? (left as any).name ?? "" : "";
    const rightName = typeof right === "object" && right ? (right as any).name ?? "" : "";
    return String(leftName).localeCompare(String(rightName));
  });
  return schemaHash(ordered);
}

export function fingerprintToolCatalog(
  contracts: Iterable<CodexToolContract>,
): string {
  const snapshot = [...contracts]
    .map((contract) => contract.snapshot())
    .sort((left, right) => left.name.localeCompare(right.name));
  return schemaHash(snapshot);
}

function normalizeBudget(value: number | undefined): number {
  if (value === undefined) return DEFAULT_OUTPUT_BUDGET_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Tool output budget must be a positive safe integer, got ${value}`);
  }
  return value;
}

class RegisteredCodexToolContract<TParams extends TSchema = TSchema>
  implements CodexToolContract<TParams>
{
  readonly name: string;
  readonly description: string;
  readonly parameters: TParams;
  readonly definition: ToolDefinition<TParams, any, any>;
  readonly exposure: CodexToolExposure;
  readonly namespace?: string;
  readonly search?: CodexToolSearchMetadata;
  readonly schemaVersion: string;
  readonly schemaHash: string;
  readonly parallelism: CodexToolParallelism;
  readonly capabilities: readonly string[];
  readonly outputBudgetBytes: number;
  readonly supportsParallelToolCalls: boolean;

  constructor(
    definition: ToolDefinition<TParams, any, any>,
    metadata: CodexToolContractMetadata = {},
  ) {
    this.definition = definition;
    this.name = definition.name;
    this.description = definition.description;
    this.parameters = definition.parameters;
    this.exposure = metadata.exposure ?? "direct";
    this.namespace = metadata.namespace ?? metadata.search?.namespace;
    this.search = metadata.search
      ? {
          ...metadata.search,
          ...(metadata.search.keywords
            ? { keywords: [...metadata.search.keywords] }
            : {}),
        }
      : undefined;
    this.schemaVersion = metadata.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
    this.parallelism =
      metadata.parallelism ??
      (definition.executionMode === "sequential" ? "sequential" : "parallel");
    this.supportsParallelToolCalls = this.parallelism === "parallel";
    this.capabilities = [...new Set(metadata.capabilities ?? [])].sort();
    this.outputBudgetBytes = normalizeBudget(metadata.outputBudgetBytes);
    this.schemaHash = schemaHash({
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      constrainedSampling: definition.constrainedSampling,
      schemaVersion: this.schemaVersion,
    });
  }

  isDirect(): boolean {
    return this.exposure === "direct" || this.exposure === "direct_model_only";
  }

  isAvailableInCodeMode(): boolean {
    return this.exposure === "direct" || this.exposure === "deferred";
  }

  toCodexTool(exposure = this.exposure): CodexToolSpec | undefined {
    if (exposure === "hidden") return undefined;
    const tool: CodexToolSpec = {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
    };
    if (this.definition.constrainedSampling !== undefined) {
      tool.constrainedSampling = this.definition.constrainedSampling;
    }
    if (exposure === "deferred") tool.defer_loading = true;
    return tool;
  }

  snapshot(): CodexToolContractSnapshot {
    return {
      name: this.name,
      description: this.description,
      exposure: this.exposure,
      ...(this.namespace ? { namespace: this.namespace } : {}),
      ...(this.search ? { search: this.search } : {}),
      schemaVersion: this.schemaVersion,
      schemaHash: this.schemaHash,
      parallelism: this.parallelism,
      capabilities: [...this.capabilities],
      outputBudgetBytes: this.outputBudgetBytes,
      spec: this.toCodexTool("direct")!,
    };
  }
}

export class ToolContractRegistry {
  private readonly contracts = new Map<string, CodexToolContract>();

  register<TParams extends TSchema>(
    definition: ToolDefinition<TParams, any, any>,
    metadata: CodexToolContractMetadata = {},
  ): CodexToolContract<TParams> {
    if (this.contracts.has(definition.name)) {
      throw new Error(`A Codex tool contract is already registered for ${definition.name}`);
    }
    const contract = new RegisteredCodexToolContract(definition, metadata);
    this.contracts.set(contract.name, contract);
    return contract;
  }

  get(name: string): CodexToolContract | undefined {
    return this.contracts.get(name);
  }

  values(): IterableIterator<CodexToolContract> {
    return this.contracts.values();
  }

  toCodexTools(options: {
    names?: Iterable<string>;
    includeDeferred?: boolean;
  } = {}): CodexToolSpec[] {
    const names = options.names ? new Set(options.names) : undefined;
    const tools: CodexToolSpec[] = [];
    for (const contract of this.contracts.values()) {
      if (names && !names.has(contract.name)) continue;
      if (contract.exposure === "hidden") continue;
      if (contract.exposure === "deferred" && !options.includeDeferred) continue;
      const tool = contract.toCodexTool();
      if (tool) tools.push(tool);
    }
    return tools;
  }

  fingerprint(): string {
    return fingerprintToolCatalog(this.contracts.values());
  }
}

export function createToolContract<TParams extends TSchema>(
  definition: ToolDefinition<TParams, any, any>,
  metadata: CodexToolContractMetadata = {},
): CodexToolContract<TParams> {
  return new RegisteredCodexToolContract(definition, metadata);
}
