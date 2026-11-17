/* ========================================================================== *
 * cloud-model.ts
 *
 * Provider-neutral Cloud ontology.
 *
 * Nothing in this file knows what Cloudflare, AWS, Redis, S3, SQL, etc. are.
 *
 * Declaration
 *      ↓
 * Requirements
 *      ↓
 * Composition
 *      ↓
 * Generic capabilities
 *      ↓
 * Provider adapter
 * ========================================================================== */

// ---------------------------------------------------------------------------
// Fundamental vocabulary
// ---------------------------------------------------------------------------

export type CloudMode =
  | "runtime"
  | "init";

export type CloudOperation =
  | "write"
  | "read"
  | "delete"
  | "think"
  | "process"
  | "object";

export type CloudServiceKind =
  | "cache"
  | "database"
  | "storage"
  | "index"
  | "mind"
  | "processor"
  | "queue"
  | "workflow"
  | "object";

export type ShapeKind =
  | "record"
  | "document"
  | "scalar"
  | "blob"
  | "stream"
  | "unknown";

export interface CloudShape {

  kind: ShapeKind;

  size?: number;

  contentType?: string;

  fields?: Record<string, CloudFieldShape>;
}

export interface CloudFieldShape {
  type:
    | "string"
    | "number"
    | "boolean"
    | "date"
    | "object"
    | "array"
    | "binary"
    | "unknown";

  nullable?: boolean;
  key?: boolean;
  searchable?: boolean;
  semantic?: boolean;
}

// ---------------------------------------------------------------------------
// Canonical requirements
// ---------------------------------------------------------------------------
export type CloudSpeed =
  | "normal"
  | "fast";

export type CloudDurability =
  | "ephemeral"
  | "persistent";

export type CloudConsistency =
  | "eventual"
  | "fresh"
  | "realtime";

export type CloudExecution =
  | "now"
  | "later";

export interface CloudLifetime {
  ttlMs?: number;
  expiresAt?: string;
}

export type FieldSelection =
  | boolean
  | string[];

export interface CloudSearchRequirements {
  lexical?: FieldSelection;

  semantic?: FieldSelection;
}

export interface CloudRequirements {
  speed: CloudSpeed;

  durability: CloudDurability;

  consistency: CloudConsistency;

  execution: CloudExecution;

  lifetime?: CloudLifetime;

  search?: CloudSearchRequirements;

  /**
   * Requires identity-scoped authoritative coordination.
   */
  coordinated: boolean;

  /**
   * The operation itself represents a durable multi-stage process.
   */
  workflow: boolean;
}


// ---------------------------------------------------------------------------
// Friendly shorthand accepted by Cloud
// ---------------------------------------------------------------------------

export interface CloudRequirementInput
  extends Partial<CloudRequirements> {

  fast?: boolean;

  persistent?: boolean;

  ephemeral?: boolean;

  fresh?: boolean;

  realtime?: boolean;

  now?: boolean;

  later?: boolean;

  searchable?: FieldSelection;

  semantic?: FieldSelection;
}


export const DEFAULT_REQUIREMENTS: CloudRequirements = {
  speed: "normal",

  durability: "persistent",

  consistency: "eventual",

  execution: "now",

  coordinated: false,

  workflow: false
};


export function normalizeRequirements(
  input: CloudRequirementInput = {}
): CloudRequirements {

  const requirements: CloudRequirements = {
    ...DEFAULT_REQUIREMENTS,
    ...input,

    search: {
      ...(input.search ?? {})
    }
  };


  // Shorthand ---------------------------------------------------------------

  if (input.fast === true)
    requirements.speed = "fast";

  if (input.persistent === true)
    requirements.durability = "persistent";

  if (input.ephemeral === true)
    requirements.durability = "ephemeral";

  if (input.fresh === true)
    requirements.consistency = "fresh";

  if (input.realtime === true)
    requirements.consistency = "realtime";

  if (input.now === true)
    requirements.execution = "now";

  if (input.now === false || input.later === true)
    requirements.execution = "later";

  if (input.searchable !== undefined)
    requirements.search!.lexical = input.searchable;

  if (input.semantic !== undefined)
    requirements.search!.semantic = input.semantic;


  return requirements;
}


// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface CompositionContext {
  mode: CloudMode;

  operation: CloudOperation;

  shape: CloudShape;

  requirements: CloudRequirements;
}


export interface CloudPlanStep {
  id: string;

  use: CloudServiceKind;

  action: string;

  dependsOn?: string[];

  deferred?: boolean;

  mode?:
    | "authoritative"
    | "projection"
    | "write-through"
    | "invalidate"
    | "fallback";

  metadata?: Record<string, unknown>;
}


export interface CloudPlan {
  mode: CloudMode;

  operation: CloudOperation;

  services: CloudServiceKind[];

  steps: CloudPlanStep[];

  returns:
    | "result"
    | "job";

  requirements: CloudRequirements;

  shape: CloudShape;
}


// ---------------------------------------------------------------------------
// Composition pattern description
// ---------------------------------------------------------------------------

export interface CompositionPattern {
  id: string;

  description: string;

  services: CloudServiceKind[];
}


export const COMPOSITION_PATTERNS = {

  persistentRecord: {
    id: "persistent-record",
    description:
      "Structured persistent state has a database authority.",
    services: ["database"]
  },

  persistentBlob: {
    id: "persistent-blob",
    description:
      "Binary or streaming persistent state has a storage authority.",
    services: ["storage"]
  },

  fastEphemeral: {
    id: "fast-ephemeral",
    description:
      "Fast non-authoritative state may live directly in cache.",
    services: ["cache"]
  },

  persistentFast: {
    id: "persistent-fast",
    description:
      "Durable authority plus scalable read projection.",
    services: ["database", "cache"]
  },

  persistentFastRealtime: {
    id: "persistent-fast-realtime",
    description:
      "Authority and cache are synchronously updated using write-through.",
    services: ["database", "cache"]
  },

  semanticRecord: {
    id: "semantic-record",
    description:
      "Persistent information plus embedding generation and semantic index.",
    services: ["database", "mind", "index"]
  },

  semanticBlob: {
    id: "semantic-blob",
    description:
      "Blob authority plus processing, embedding and semantic index.",
    services: ["storage", "processor", "mind", "index"]
  },

  deferredWrite: {
    id: "deferred-write",
    description:
      "Queue accepts work immediately and authoritative work executes later.",
    services: ["queue"]
  },

  coordinatedObject: {
    id: "coordinated-object",
    description:
      "Identity-scoped authoritative coordination.",
    services: ["object"]
  },

  coordinatedFastObject: {
    id: "coordinated-fast-object",
    description:
      "Coordinated object authority with scalable cache projection.",
    services: ["object", "cache"]
  },

  thinking: {
    id: "thinking",
    description:
      "Immediate cognitive/inference operation.",
    services: ["mind"]
  },

  deferredThinking: {
    id: "deferred-thinking",
    description:
      "Queued inference operation.",
    services: ["queue", "mind"]
  },

  processing: {
    id: "processing",
    description:
      "Immediate general computation.",
    services: ["processor"]
  },

  deferredProcessing: {
    id: "deferred-processing",
    description:
      "Queued general computation.",
    services: ["queue", "processor"]
  },

  workflow: {
    id: "workflow",
    description:
      "Durable multi-stage orchestration.",
    services: ["workflow"]
  }

} satisfies Record<string, CompositionPattern>;


// ---------------------------------------------------------------------------
// Authority resolution
// ---------------------------------------------------------------------------

export function authorityFor(
  shape: CloudShape,
  requirements: CloudRequirements
): CloudServiceKind {

  if (requirements.coordinated)
    return "object";

  if (
    shape.kind === "blob" ||
    shape.kind === "stream"
  )
    return "storage";

  if (
    requirements.durability === "ephemeral" &&
    requirements.speed === "fast"
  )
    return "cache";

  return "database";
}


// ---------------------------------------------------------------------------
// Composition compiler
// ---------------------------------------------------------------------------

export function compose(
  context: CompositionContext
): CloudPlan {

  const {
    mode,
    operation,
    shape,
    requirements
  } = context;


  const authority = authorityFor(shape, requirements);


  // INIT --------------------------------------------------------------------
  //
  // Init uses exactly the same requirements, but converts them into potential:
  // ensure that the capabilities necessary for the runtime composition exist.

  if (mode === "init") {

    const runtime = compose({
      ...context,
      mode: "runtime"
    });

    const services = unique(runtime.services);

    return {
      mode,
      operation,
      requirements,
      shape,
      services,

      returns: "result",

      steps: services.map((service, index) => ({
        id: `ensure:${index}`,
        use: service,
        action: "ensure"
      }))
    };
  }


  // THINK -------------------------------------------------------------------

  if (operation === "think") {

    if (requirements.execution === "later") {

      return plan(context, "job", [

        {
          id: "queue",
          use: "queue",
          action: "enqueue",
          metadata: {
            continuation: "mind"
          }
        },

        {
          id: "think",
          use: "mind",
          action: "think",
          dependsOn: ["queue"],
          deferred: true
        }

      ]);
    }

    return plan(context, "result", [
      {
        id: "think",
        use: "mind",
        action: "think"
      }
    ]);
  }


  // PROCESS -----------------------------------------------------------------

  if (operation === "process") {

    if (requirements.workflow) {

      return plan(context, "job", [
        {
          id: "workflow",
          use: "workflow",
          action: "start"
        }
      ]);
    }


    if (requirements.execution === "later") {

      return plan(context, "job", [

        {
          id: "queue",
          use: "queue",
          action: "enqueue",
          metadata: {
            continuation: "processor"
          }
        },

        {
          id: "process",
          use: "processor",
          action: "process",
          dependsOn: ["queue"],
          deferred: true
        }

      ]);
    }


    return plan(context, "result", [
      {
        id: "process",
        use: "processor",
        action: "process"
      }
    ]);
  }


  // OBJECT ------------------------------------------------------------------

  if (operation === "object") {

    const steps: CloudPlanStep[] = [

      {
        id: "object",
        use: "object",
        action: "resolve",
        mode: "authoritative"
      }

    ];


    if (requirements.speed === "fast") {

      steps.push({
        id: "cache",
        use: "cache",
        action: "project",
        dependsOn: ["object"],
        mode: "projection"
      });
    }


    return plan(context, "result", steps);
  }


  // DEFERRED DATA MUTATION --------------------------------------------------

  if (
    requirements.execution === "later" &&
    (operation === "write" || operation === "delete")
  ) {

    return plan(context, "job", [

      {
        id: "queue",
        use: "queue",
        action: "enqueue",

        metadata: {
          operation,
          authority,

          continuation: {
            operation,
            requirements: {
              ...requirements,
              execution: "now"
            }
          }
        }
      }

    ]);
  }


  // WRITE -------------------------------------------------------------------

  if (operation === "write") {

    const steps: CloudPlanStep[] = [

      {
        id: "authority",
        use: authority,
        action: "upsert",
        mode: "authoritative"
      }

    ];

    // Fast projection --------------------------------------------------------

    if (
      requirements.speed === "fast" &&
      authority !== "cache"
    ) {

      if (requirements.consistency === "realtime") {

        steps.push({
          id: "cache",
          use: "cache",
          action: "upsert",
          dependsOn: ["authority"],
          mode: "write-through"
        });

      } else {
        steps.push({
          id: "cache-stale",
          use: "cache",
          action: "stale",
          dependsOn: ["authority"],
          mode: "invalidate"
        });

        steps.push({
          id: "cache-refresh",
          use: "cache",
          action: "refresh",
          dependsOn: ["cache-stale"],
          deferred: true,
          mode: "projection"
        });
      }
    }


    // Semantic projection ----------------------------------------------------

    if (requirements.search?.semantic) {

      steps.push({
        id: "embedding",
        use: "mind",
        action: "embed",
        dependsOn: ["authority"]
      });

      steps.push({
        id: "semantic-index",
        use: "index",
        action: "upsert",
        dependsOn: ["embedding"],
        mode: "projection"
      });
    }

    return plan(context, "result", steps);
  }


  // READ --------------------------------------------------------------------

  if (operation === "read") {

    if (
      requirements.speed === "fast" &&
      requirements.consistency === "eventual" &&
      authority !== "cache"
    ) {

      return plan(context, "result", [

        {
          id: "cache",
          use: "cache",
          action: "read",
          mode: "projection",

          metadata: {
            fallback: authority
          }
        }

      ]);
    }


    return plan(context, "result", [
      {
        id: "authority",
        use: authority,
        action: "read",
        mode: "authoritative"
      }
    ]);
  }


  // DELETE ------------------------------------------------------------------

  if (operation === "delete") {

    const steps: CloudPlanStep[] = [
      {
        id: "authority",
        use: authority,
        action: "delete",
        mode: "authoritative"
      }
    ];


    if (
      requirements.speed === "fast" &&
      authority !== "cache"
    ) {
      steps.push({
        id: "cache",
        use: "cache",
        action:
          requirements.consistency === "realtime"
            ? "delete"
            : "stale",

        dependsOn: ["authority"]
      });
    }

    if (requirements.search?.semantic) {
      steps.push({
        id: "index",
        use: "index",
        action: "delete",
        dependsOn: ["authority"]
      });
    }

    return plan(context, "result", steps);
  }

  throw new Error(
    `Unsupported Cloud operation: ${operation}`
  );
}


// ---------------------------------------------------------------------------
// Plan helpers
// ---------------------------------------------------------------------------

function plan(
  context: CompositionContext,
  returns: "result" | "job",
  steps: CloudPlanStep[]
): CloudPlan {

  return {
    mode: context.mode,
    operation: context.operation,
    requirements: context.requirements,
    shape: context.shape,
    returns,
    steps,
    services: unique(
      steps.map(step => step.use)
    )
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

// ===========================================================================
// Generic service contracts
// ===========================================================================

export interface ServiceWriteOptions {
  ttlMs?: number;
  contentType?: string;
  metadata?: Record<string, unknown>;
}

export interface CacheService {

  read<T = unknown>(
    key: string
  ): Promise<T | null>;

  upsert<T>(
    key: string,
    value: T,
    options?: ServiceWriteOptions
  ): Promise<void>;

  delete(
    key: string
  ): Promise<void>;

  /**
   * Invalidation semantic.
   *
   * Provider may implement this as:
   * - delete
   * - version bump
   * - dirty flag
   * - invalidation record
   */
  stale(
    key: string
  ): Promise<void>;
}

export interface DatabaseService {

  read<T = unknown>(
    id: string
  ): Promise<T | null>;

  upsert<T>(
    id: string,
    value: T,
    options?: ServiceWriteOptions
  ): Promise<void>;

  delete(
    id: string
  ): Promise<void>;

  query?<T = unknown>(
    query: unknown,
    parameters?: unknown[]
  ): Promise<T[]>;
}


export interface StorageReadResult {
  value: ArrayBuffer;
  contentType?: string;
  metadata?: Record<string, string>;
}


export interface StorageService {

  read(
    key: string
  ): Promise<StorageReadResult | null>;

  upsert(
    key: string,
    value: unknown,
    options?: ServiceWriteOptions
  ): Promise<void>;

  delete(
    key: string
  ): Promise<void>;

  list?(
    prefix?: string
  ): Promise<string[]>;
}


// ---------------------------------------------------------------------------
// Search / index
// ---------------------------------------------------------------------------

export interface VectorEntry {
  id: string;
  values: number[];
  metadata?: Record<string, string | number | boolean>;
}


export interface VectorMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface IndexService {

  upsert(
    entry: VectorEntry | VectorEntry[]
  ): Promise<void>;

  query(
    vector: number[],
    options?: {
      topK?: number;
      filter?: unknown;
    }
  ): Promise<VectorMatch[]>;

  delete(
    ids: string | string[]
  ): Promise<void>;
}


// ---------------------------------------------------------------------------
// Mind
// ---------------------------------------------------------------------------

export interface MindService {

  think<T = unknown>(
    task: string,
    input: unknown,
    options?: Record<string, unknown>
  ): Promise<T>;

  embed(
    input: string | string[],
    options?: Record<string, unknown>
  ): Promise<number[][]>;
}


// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

export interface ProcessorService {

  process<T = unknown>(
    operation: string,
    input: unknown,
    options?: Record<string, unknown>
  ): Promise<T>;
}


// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface CloudJob {
  id: string;
  operation: CloudOperation;
  target?: CloudServiceKind;
  ref?: string;
  input?: unknown;
  requirements?: CloudRequirements;
  continuation?: unknown;
}

export interface QueueService {
  enqueue(
    job: CloudJob,
    options?: {
      delaySeconds?: number;
    }
  ): Promise<void>;
}


// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export interface WorkflowInstance {
  id: string;
  status:
    | "queued"
    | "running"
    | "waiting"
    | "paused"
    | "complete"
    | "errored"
    | "terminated"
    | string;

  output?: unknown;
}


export interface WorkflowService {

  start(
    workflow: string,
    input: unknown,
    options?: {
      id?: string;
    }
  ): Promise<WorkflowInstance>;

  status(
    id: string
  ): Promise<WorkflowInstance>;

  cancel?(
    id: string
  ): Promise<void>;
}


// ---------------------------------------------------------------------------
// Coordinated object
// ---------------------------------------------------------------------------

export interface CloudObjectHandle {

  read<T = unknown>(): Promise<T | null>;

  write<T>(
    value: T
  ): Promise<void>;

  delete(): Promise<void>;

  process?<T = unknown>(
    operation: string,
    input: unknown
  ): Promise<T>;
}


export interface ObjectService {

  get(
    id: string
  ): CloudObjectHandle;
}


// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface CloudProviderServices {

  cache?: CacheService;

  database?: DatabaseService;

  storage?: StorageService;

  index?: IndexService;

  mind?: MindService;

  processor?: ProcessorService;

  queue?: QueueService;

  workflow?: WorkflowService;

  object?: ObjectService;
}


export interface CapabilityDescriptor {

  available: boolean;

  implementation: string;

  features?: string[];
}


export type ProviderCapabilities =
  Partial<Record<
    CloudServiceKind,
    CapabilityDescriptor
  >>;


export interface CloudProvider {

  id: string;

  services: CloudProviderServices;

  capabilities: ProviderCapabilities;
}