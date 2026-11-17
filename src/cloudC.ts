/**
 * CloudC — an intent compiler, independent of any cloud provider.
 *
 *   intent + shape + capabilities -> IR -> inspectable plan -> adapter
 *
 * This is an executable reference core, not a provider SDK. No credentials,
 * SQL, resource names, or provider calls belong here. Adapters own those.
 * Runtime reflection describes values; it NEVER infers search/AI intent or
 * creates a table for each observed record. A database adapter should begin
 * with a document/envelope representation and promote fields deliberately.
 *
 * const cloud = new CloudC({ adapter });
 * const plan = await cloud.Init.Write("customer", {
 *   shape: { id: { type: "string", key: true }, email: "string", bio: "string" },
 *   persistent: true, fast: true, searchable: ["email"], semantic: ["bio"]
 * });
 * await cloud.Apply(plan); // Explicit reconciliation, including optional seed upserts.
 * await cloud.Write("customer:123", { id: "123", email: "m@example.com", bio: "..." },
 *   { persistent: true, fast: true, fresh: true });
 * const job = await cloud.Process("resizeImage", { image: "media:123" }, "async");
 * // job = { jobID, status: "queued", via: "queue", planID }
 *
 * DESIGN CHOICES: Init mutation verbs return plans; Init.Read observes actual
 * capability state. Init.Think/Process establish contracts, never run inference
 * or user code. Object returns an identity-bound facade; Init.Object establishes
 * its capability contract. Shape reflects values in runtime and normalizes
 * declarations in Init. Plan/Apply are supporting APIs, not a second engine.
 */

export const CAPABILITIES = [
  "cache", "database", "storage", "index", "mind", "processor", "queue", "workflow", "object",
] as const;
export type Capability = typeof CAPABILITIES[number];
export type Mode = "runtime" | "init";
export type Operation = "write" | "read" | "delete" | "think" | "process" | "object";
export type Fields = boolean | readonly string[];

export interface Policy {
  /** Coordinate the operation for this ref without changing its authority. */
  coordinated?: boolean;
  fast?: boolean;
  persistent?: boolean;
  fresh?: boolean;
  stale?: boolean;
  realtime?: boolean;
  asynchronous?: boolean;
  async?: boolean;
  deferred?: boolean;
  ttl?: number; // Seconds, positive; 0 explicitly means no expiration.
  searchable?: Fields;
  semantic?: Fields;
  similar?: string;
  query?: unknown;
  workflow?: boolean | string;
  global?: boolean;
  cheap?: boolean;
  model?: string;
  idempotencyKey?: string;
  shape?: ShapeDeclaration;
}
export type Shorthand = "fast" | "persistent" | "fresh" | "stale" | "realtime" | "async" | "deferred";
export type PolicyInput = Policy | Shorthand | readonly Shorthand[];

export interface Requirements {
  coordinated: boolean;
  speed: "default" | "fast";
  durability: "ephemeral" | "persistent";
  consistency: "eventual" | "strong";
  freshness: "fresh" | "stale-ok";
  execution: "now" | "deferred";
  lifetime: number | null;
  cache: "none" | "write-through" | "stale";
  searchable: Fields;
  semantic: Fields;
  workflow: false | string;
  global: boolean;
  cheap: boolean;
}

export type ShapeKind = "unknown" | "null" | "string" | "number" | "boolean" |
  "bigint" | "undefined" | "datetime" | "blob" | "record" | "array" | "union" | "ref";
export interface Shape {
  kind: ShapeKind;
  size?: number; // Bytes where measurable; not a persistence or transport encoding.
  fields?: Record<string, Shape>;
  items?: Shape;
  variants?: Shape[];
  key?: boolean;
  searchable?: boolean;
  optional?: boolean;
}
export type ShapeDeclaration = ShapeKind | Shape | {
  type: ShapeKind; key?: boolean; searchable?: boolean; optional?: boolean;
  fields?: Record<string, ShapeDeclaration>; items?: ShapeDeclaration;
} | { [field: string]: ShapeDeclaration };

export interface InitContract extends Policy {
  input?: ShapeDeclaration;
  output?: ShapeDeclaration;
  think?: boolean;
  process?: boolean;
  /** Stable explicit refs make repeated seed reconciliation idempotent. */
  seed?: readonly { ref: string; value: unknown; policy?: PolicyInput }[];
}

/** A location/identity plus reusable intent; contains no provider locator. */
export class CloudRef {
  readonly policy: Readonly<Policy>;
  constructor(readonly id: string, policy: PolicyInput = {}) {
    if (typeof id !== "string" || !id.trim()) throw new TypeError("CloudRef requires a nonempty id");
    this.policy = Object.freeze(expandPolicy(policy));
    Object.freeze(this);
  }
  With(policy: PolicyInput): CloudRef { return new CloudRef(this.id, { ...this.policy, ...expandPolicy(policy) }); }
  toString(): string { return this.id; }
  toJSON(): { id: string; policy: Policy } { return { id: this.id, policy: this.policy }; }
}
export type Ref = string | CloudRef;

export interface CloudIR {
  version: 1;
  mode: Mode;
  operation: Operation;
  ref: string;
  objectID?: string;
  value?: unknown;
  shape: Shape;
  policy: Policy;
  requirements: Requirements;
  contract?: InitContract;
}

export interface CapabilityDescriptor {
  /** Actions the installed adapter can actually execute; no silent fallback. */
  actions: readonly string[];
  persistent?: boolean;
  strong?: boolean;
  ttl?: boolean;
  /** Provider-specific lower bound, surfaced to common plan validation. */
  minimumTTL?: number;
  global?: boolean;
  cheap?: boolean;
  /** An adapter may be able to provision a capability not yet installed. */
  provisionable?: boolean;
}
export type CapabilityCatalog = Partial<Record<Capability, CapabilityDescriptor>>;
export interface Observation {
  /** Opaque optimistic concurrency token, checked when applying a change. */
  revision?: string;
  state: unknown;
}
export interface SubjectDescription {
  shape?: ShapeDeclaration;
  /** Retained data contract, excluding per-invocation execution/freshness flags. */
  policy?: Pick<Policy, "persistent" | "fast" | "searchable" | "semantic" | "ttl" | "coordinated">;
}
export interface InitChange {
  capability: Capability;
  action: "create" | "modify" | "delete" | "noop";
  before?: unknown;
  after?: unknown;
  destructive?: boolean;
  details?: unknown;
}
export interface CacheEntry {
  hit: boolean; // Explicit discriminant: null/false/0/undefined may all be cached values.
  value?: unknown;
  stale?: boolean;
}
/** Provider authority results keep the value tied to its exact commit. */
export interface AuthorityResult {
  kind: "authority";
  hit: boolean;
  value?: unknown;
  version?: string;
  /** Absolute Unix seconds. Cache fills must never restart the source TTL. */
  expiresAt: number | null;
}
/** Index results identify authoritative records; they are not the record values. */
export interface IndexHit { ref: string; score?: number; }
export interface JobReceipt {
  jobID: string;
  status: "queued";
  via: "queue" | "workflow";
  planID: string;
}
export interface Step {
  id: string;
  capability: Capability;
  action: string;
  input: "value" | "previous" | "query" | "none";
  dependsOn?: readonly string[];
  /** Explicit data dependency; unlike ordering, this selects a step's value. */
  inputFrom?: string;
  /** Cache read miss branch. Only this branch runs an authoritative fetch. */
  onMissOf?: string;
}
export interface CloudPlan {
  version: 1;
  id: string;
  ir: CloudIR;
  required: Capability[];
  steps: Step[];
  route: "inline" | "queue" | "workflow" | "object";
  observation?: Observation;
  changes?: readonly InitChange[];
  seeds?: readonly CloudPlan[];
}
export interface StepContext {
  plan: CloudPlan;
  step: Step;
  input: unknown;
  /** Prior outputs, including branch-skipped steps as undefined. */
  results: ReadonlyMap<string, unknown>;
  /** Exact source metadata for a subsequent projection of this value. */
  authority?: AuthorityResult;
}
export interface JobEnvelope {
  version: 1;
  plan: CloudPlan;
  /** Adapters must durably deduplicate this key across deliveries/retries. */
  idempotencyKey: string;
}

/**
 * Adapter contract (all credentials/configuration are encapsulated here).
 *
 * execute actions:
 * database/storage: upsert(value), get(ref), hydrate(IndexHit[]), delete(ref)
 * cache: get -> CacheEntry, put(value), invalidate(ref)
 * mind: think(input), embed(input selected by semantic fields), embedQuery(text)
 * index: upsert(value or embedding), search(query or embedding) -> IndexHit[], delete
 * processor: run(input), with ir.ref naming a registered portable processor
 *
 * execute must honor the COMPLETE IR, including ttl, schema, consistency and
 * selected fields. validate must reject unsupported combinations, codecs,
 * arbitrary function inputs, query operators, or placement constraints. It must
 * never quietly weaken intent. checkCatalog provides only coarse validation.
 *
 * Cache put follows authoritative commit. Stale writes invalidate; they never
 * claim a refreshed cache. Fresh reads bypass cache. Cache/index failures after
 * commit are partial failures: adapters must use versions/tombstones, retries or
 * an outbox to prevent stale resurrection. This core claims no cross-capability
 * transaction or exactly-once delivery. Idempotency/TTL must survive restarts.
 *
 * enqueue/startWorkflow return ONLY after durable acceptance, with a stable jobID.
 * A consumer invokes cloud.Resume(envelope); it never queues the envelope again.
 * Workflow workers implement durable ordering/checkpoints/retries, not just a
 * queue alias. invokeObject serializes operations for the named identity and
 * executes the enclosed inline steps in that identity's coordination boundary.
 *
 * inspect/diff are read-only. diff translates actual vs desired potential into
 * create/modify/delete/noop changes (including shape/index migrations). reconcile
 * checks observation.revision and applies idempotently; concurrent or destructive
 * changes must be handled explicitly by the adapter. It must never drop shared
 * resources when deleting one subject. Init.Read inspects actual potential.
 * describe is a read-only subject manifest lookup, retained across restarts by
 * the adapter. It preserves authority shape and cache/index contracts when later
 * calls omit those policies. Without it, callers must reuse a CloudRef carrying
 * that contract. A subject changing shape/authority requires adapter migration;
 * this core never silently moves data between database and storage.
 */
export interface CloudAdapter {
  capabilities(): Promise<CapabilityCatalog> | CapabilityCatalog;
  validate(plan: CloudPlan): Promise<void> | void;
  execute(context: StepContext): Promise<unknown>;
  describe?(ref: string): Promise<SubjectDescription | undefined>;
  inspect?(ir: CloudIR): Promise<Observation>;
  diff?(ir: CloudIR, required: readonly Capability[], current: Observation): Promise<readonly InitChange[]>;
  reconcile?(plan: CloudPlan): Promise<unknown>;
  enqueue?(envelope: JobEnvelope): Promise<{ jobID: string }>;
  startWorkflow?(envelope: JobEnvelope): Promise<{ jobID: string }>;
  invokeObject?(plan: CloudPlan): Promise<unknown>;
}

const shorthandKeys = new Set(["fast", "persistent", "fresh", "stale", "realtime", "async", "deferred"]);
const policyKeys = new Set([
  ...shorthandKeys, "asynchronous", "ttl", "searchable", "semantic", "similar", "query",
  "workflow", "global", "cheap", "model", "idempotencyKey", "shape", "coordinated",
]);
function expandPolicy(input: PolicyInput): Policy {
  if (typeof input === "string" || Array.isArray(input)) {
    const result: Record<string, boolean> = {};
    for (const key of typeof input === "string" ? [input] : input) {
      if (!shorthandKeys.has(key)) throw new TypeError(`Unknown policy shorthand: ${key}`);
      result[key] = true;
    }
    return result;
  }
  if (!input || typeof input !== "object") throw new TypeError("Policy must be an object or shorthand");
  for (const key of Object.keys(input)) {
    if (!policyKeys.has(key)) throw new TypeError(`Unknown policy: ${key}`);
  }
  return { ...input as Policy };
}

export function normalizePolicy(input: PolicyInput = {}): { policy: Policy; requirements: Requirements } {
  const policy = expandPolicy(input);
  for (const key of ["fast", "persistent", "fresh", "stale", "realtime", "async", "asynchronous", "deferred", "global", "cheap", "coordinated"] as const) {
    if (policy[key] !== undefined && typeof policy[key] !== "boolean") throw new TypeError(`${key} must be boolean`);
  }
  for (const key of ["searchable", "semantic"] as const) {
    const v = policy[key];
    if (v !== undefined && typeof v !== "boolean" && !(Array.isArray(v) && v.every(x => typeof x === "string" && x.length))) {
      throw new TypeError(`${key} must be boolean or field names`);
    }
  }
  if (policy.ttl !== undefined && (!Number.isFinite(policy.ttl) || policy.ttl < 0)) throw new TypeError("ttl must be nonnegative seconds");
  if (policy.fresh && policy.stale || policy.realtime && policy.stale) throw new TypeError("fresh/realtime conflicts with stale");
  if (policy.workflow !== undefined && typeof policy.workflow !== "boolean" && !(typeof policy.workflow === "string" && policy.workflow.length)) throw new TypeError("workflow must be boolean or a name");
  if (policy.similar !== undefined && typeof policy.similar !== "string") throw new TypeError("similar must be text");
  if (policy.similar !== undefined && policy.query !== undefined) throw new TypeError("Choose query or similar");
  if (policy.idempotencyKey !== undefined && !policy.idempotencyKey.trim()) throw new TypeError("idempotencyKey must be nonempty");
  const fresh = policy.fresh === true || policy.realtime === true || policy.stale === false;
  return { policy, requirements: {
    coordinated: policy.coordinated ?? false,
    speed: policy.fast ? "fast" : "default",
    durability: policy.persistent ? "persistent" : "ephemeral",
    consistency: policy.realtime ? "strong" : "eventual",
    freshness: fresh ? "fresh" : "stale-ok",
    execution: policy.async || policy.asynchronous || policy.deferred ? "deferred" : "now",
    lifetime: policy.ttl ? policy.ttl : null,
    cache: policy.fast ? fresh ? "write-through" : "stale" : "none",
    searchable: policy.searchable ?? false,
    semantic: policy.semantic ?? false,
    workflow: policy.workflow === true ? "default" : policy.workflow || false,
    global: policy.global ?? false,
    cheap: policy.cheap ?? false,
  } };
}

/** Reflection is cycle-safe and distinguishes heterogeneous arrays and binary. */
export function reflectShape(value: unknown, ancestors = new Set<object>()): Shape {
  if (value === null) return { kind: "null" };
  if (value instanceof CloudRef) return { kind: "ref" };
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError("Invalid Date");
    return { kind: "datetime" };
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return { kind: "blob", size: value.byteLength };
  if (typeof Blob !== "undefined" && value instanceof Blob) return { kind: "blob", size: value.size };
  if (typeof value === "string") return { kind: "string", size: new TextEncoder().encode(value).length };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite numbers require an explicit codec");
    return { kind: "number" };
  }
  if (typeof value === "boolean" || typeof value === "bigint" || typeof value === "undefined") return { kind: typeof value as ShapeKind };
  if (typeof value !== "object") throw new TypeError("Functions/symbols are not portable Cloud values");
  if (ancestors.has(value)) throw new TypeError("Cyclic Cloud value requires an explicit codec");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const unique = new Map<string, Shape>();
      for (const item of value) {
        const shape = reflectShape(item, ancestors);
        // Strip size from union identity: lengths do not introduce new types.
        const key = JSON.stringify(shape, (k, v) => k === "size" ? undefined : v);
        unique.set(key, shape);
      }
      const variants = [...unique.values()];
      return { kind: "array", items: variants.length === 0 ? { kind: "unknown" } : variants.length === 1 ? variants[0] : { kind: "union", variants } };
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError("Custom class requires an explicit adapter codec");
    }
    const fields: Record<string, Shape> = Object.create(null);
    for (const key of Object.keys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key)!;
      if (!Object.hasOwn(d, "value")) throw new TypeError("Cloud reflection does not invoke getters");
      fields[key] = reflectShape(d.value, ancestors);
    }
    return { kind: "record", fields };
  } finally { ancestors.delete(value); }
}

const shapeKinds = new Set<ShapeKind>(["unknown", "null", "string", "number", "boolean", "bigint", "undefined", "datetime", "blob", "record", "array", "union", "ref"]);
/**
 * Explicit declarations, unlike reflection, can express keys/indexable fields.
 * Use { kind: "record", fields: {...} } for maps containing reserved type/kind
 * names; bare field maps and descriptor objects otherwise share shorthand syntax.
 */
export function normalizeShape(declaration: ShapeDeclaration): Shape {
  if (typeof declaration === "string") {
    if (!shapeKinds.has(declaration)) throw new TypeError(`Unknown shape: ${declaration}`);
    return { kind: declaration };
  }
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) throw new TypeError("Invalid shape declaration");
  const d = declaration as Record<string, unknown>;
  const kind = typeof d.kind === "string" ? d.kind : typeof d.type === "string" ? d.type : undefined;
  if (kind !== undefined) {
    if (!shapeKinds.has(kind as ShapeKind)) throw new TypeError(`Unknown shape: ${kind}`);
    const result: Shape = { kind: kind as ShapeKind };
    for (const k of ["key", "searchable", "optional"] as const) {
      if (d[k] !== undefined) {
        if (typeof d[k] !== "boolean") throw new TypeError(`Shape ${k} must be boolean`);
        result[k] = d[k];
      }
    }
    if (d.fields) {
      if (typeof d.fields !== "object" || Array.isArray(d.fields)) throw new TypeError("Shape fields must be a map");
      result.fields = Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, normalizeShape(v as ShapeDeclaration)]));
    }
    if (d.items) result.items = normalizeShape(d.items as ShapeDeclaration);
    if (d.variants) {
      if (!Array.isArray(d.variants)) throw new TypeError("Shape variants must be an array");
      result.variants = d.variants.map(normalizeShape);
    }
    return result;
  }
  return { kind: "record", fields: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, normalizeShape(v as ShapeDeclaration)])) };
}

function enabled(fields: Fields): boolean { return fields === true || Array.isArray(fields) && fields.length > 0; }
function uid(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("Supply CloudOptions.id when crypto.randomUUID is unavailable");
  return globalThis.crypto.randomUUID();
}
export interface CloudOptions {
  adapter?: CloudAdapter;
  /** The composer/conductor vocabulary uses provider; adapter is an alias. */
  provider?: CloudAdapter;
  /** Deliberate defaults: persistence is a contract, not inferred from a value. */
  defaults?: PolicyInput;
  id?: () => string;
}

/** Public view; every verb delegates to the same Cloud engine with a mode bit. */
export type MutationResult<M extends Mode> = M extends "init" ? CloudPlan : unknown;
export type ObjectResult<M extends Mode> = M extends "init" ? Promise<CloudPlan> : CloudObject;
export class CloudMode<M extends Mode = Mode> {
  constructor(private readonly root: CloudC | undefined, readonly mode: M, readonly objectID?: string) {}
  protected get engine(): CloudC { return this.root ?? this as unknown as CloudC; }
  Write(ref: Ref, value: unknown, policy: PolicyInput = {}): Promise<MutationResult<M>> {
    return this.engine.Submit(this.mode, "write", ref, value, policy, this.objectID) as Promise<MutationResult<M>>;
  }
  Read(ref: Ref, policy: PolicyInput = {}): Promise<M extends "init" ? Observation : unknown> {
    return this.engine.Submit(this.mode, "read", ref, undefined, policy, this.objectID) as Promise<M extends "init" ? Observation : unknown>;
  }
  Delete(ref: Ref, policy: PolicyInput = {}): Promise<MutationResult<M>> {
    return this.engine.Submit(this.mode, "delete", ref, undefined, policy, this.objectID) as Promise<MutationResult<M>>;
  }
  Think(ref: Ref, input: unknown, policy: PolicyInput = {}): Promise<MutationResult<M>> {
    return this.engine.Submit(this.mode, "think", ref, input, policy, this.objectID) as Promise<MutationResult<M>>;
  }
  Process(ref: Ref, input: unknown, policy: PolicyInput = {}): Promise<MutationResult<M>> {
    return this.engine.Submit(this.mode, "process", ref, input, policy, this.objectID) as Promise<MutationResult<M>>;
  }
  Object(ref: Ref, policy: PolicyInput = {}): ObjectResult<M> {
    if (this.mode === "init") return this.engine.Plan("object", ref, {}, policy, "init") as ObjectResult<M>;
    return new CloudObject(this.engine, ref instanceof CloudRef ? ref.With(policy) : new CloudRef(ref, policy)) as ObjectResult<M>;
  }
  Shape(value: unknown): Shape {
    return this.mode === "init" ? normalizeShape(value as ShapeDeclaration) : reflectShape(value);
  }
}

/** Identity-bound state and behavior. Construction performs no remote I/O. */
export class CloudObject {
  constructor(private readonly engine: CloudC, readonly ref: CloudRef) {}
  private view(): CloudMode { return new CloudMode(this.engine, "runtime", this.ref.id); }
  Write(value: unknown, policy: PolicyInput = {}): Promise<unknown> { return this.view().Write(this.ref, value, policy); }
  Read(policy: PolicyInput = {}): Promise<unknown> { return this.view().Read(this.ref, policy); }
  Delete(policy: PolicyInput = {}): Promise<unknown> { return this.view().Delete(this.ref, policy); }
  Think(input: unknown, policy: PolicyInput = {}): Promise<unknown> { return this.view().Think(this.ref, input, policy); }
  Process(input: unknown, policy: PolicyInput = {}): Promise<unknown> { return this.view().Process(this.ref, input, policy); }
  Shape(value: unknown): Shape { return this.engine.Shape(value); }
}

export class CloudC extends CloudMode<"runtime"> {
  readonly Init: CloudMode<"init">;
  private readonly adapter?: CloudAdapter;
  private readonly defaults: Policy;
  private readonly makeID: () => string;
  constructor(options: CloudOptions = {}) {
    // The runtime view is the engine itself; the base only stores its pointer.
    super(undefined, "runtime");
    if (options.adapter && options.provider && options.adapter !== options.provider) throw new TypeError("Choose one Cloud provider");
    this.adapter = options.provider ?? options.adapter;
    this.defaults = expandPolicy(options.defaults ?? { persistent: true });
    this.makeID = options.id ?? uid;
    this.Init = new CloudMode(this, "init");
  }

  private requireAdapter(): CloudAdapter {
    if (!this.adapter) throw new Error("No Cloud adapter installed; Plan is available offline");
    return this.adapter;
  }

  /** Runtime specialization keeps identity handles synchronous and well typed. */
  override Object(ref: Ref, policy: PolicyInput = {}): CloudObject {
    return new CloudObject(this, ref instanceof CloudRef ? ref.With(policy) : new CloudRef(ref, policy));
  }

  /** Public compilation hook: no mutations; metadata and Init diff are read-only. */
  async Plan(operation: Operation, ref: Ref, value?: unknown, policy: PolicyInput = {}, mode: Mode = "runtime", objectID?: string): Promise<CloudPlan> {
    const subject = ref instanceof CloudRef ? ref : new CloudRef(ref);
    const description = mode === "runtime" && ["write", "read", "delete"].includes(operation)
      ? await this.adapter?.describe?.(subject.id) : undefined;
    let contract: InitContract | undefined;
    let contractPolicy: Policy = {};
    if (mode === "init" && operation !== "read" && operation !== "delete") {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Init requires a capability contract");
      contract = value as InitContract;
      const extras = new Set(["input", "output", "think", "process", "seed"]);
      for (const [key, v] of Object.entries(contract)) {
        if (!policyKeys.has(key) && !extras.has(key)) throw new TypeError(`Unknown init contract field: ${key}`);
        if (policyKeys.has(key)) (contractPolicy as Record<string, unknown>)[key] = v;
      }
      if (contract.input) normalizeShape(contract.input);
      if (contract.output) normalizeShape(contract.output);
    }
    const normalized = normalizePolicy({ ...this.defaults, ...description?.policy, ...subject.policy, ...contractPolicy, ...expandPolicy(policy) });
    const declaration = normalized.policy.shape ?? description?.shape;
    const shape = declaration ? normalizeShape(declaration) : mode === "init" ? { kind: "unknown" } as Shape : reflectShape(value);
    // Field-level search declarations are explicit intent, unlike reflected strings.
    const searchable = Object.entries(shape.fields ?? {}).filter(([, s]) => s.searchable).map(([name]) => name);
    if (normalized.policy.searchable === undefined && searchable.length) normalized.requirements.searchable = searchable;
    const ir: CloudIR = { version: 1, mode, operation, ref: subject.id,
      objectID: objectID ?? (normalized.requirements.coordinated ? subject.id : undefined),
      value: mode === "runtime" ? value : undefined, shape, ...normalized, contract };
    const plan = compose(ir, this.makeID);
    if (mode === "init" && operation !== "read" && this.adapter) {
      if (!this.adapter.inspect || !this.adapter.diff) throw new Error("Init planning requires adapter.inspect and adapter.diff");
      plan.observation = await this.adapter.inspect(ir);
      plan.changes = await this.adapter.diff(ir, plan.required, plan.observation);
    }
    if (contract?.seed) {
      if (!Array.isArray(contract.seed)) throw new TypeError("seed must be an array of { ref, value, policy? }");
      if (operation !== "write") throw new TypeError("Only Init.Write accepts seed data");
      plan.seeds = [];
      for (const seed of contract.seed) {
        // Seeding is ordinary runtime upsert, AFTER successful reconciliation.
        // Compile offline: installed resources may not exist until reconcile.
        // The parent adapter validates the complete init plan before applying it;
        // each seed is validated against installed capabilities after reconcile.
        const seedPlan = await new CloudC({ defaults: this.defaults, id: this.makeID }).Plan("write", seed.ref, seed.value, {
          ...normalized.policy, ...expandPolicy(seed.policy ?? {}),
          asynchronous: false, async: false, deferred: false, workflow: false,
        });
        (plan.seeds as CloudPlan[]).push(seedPlan);
      }
    }
    if (this.adapter) {
      this.checkCatalog(plan, await this.adapter.capabilities());
      await this.adapter.validate(plan);
    }
    return plan;
  }

  /** Internal public hook for mode/identity views; applications normally use verbs. */
  async Submit(mode: Mode, operation: Operation, ref: Ref, value: unknown, policy: PolicyInput, objectID?: string): Promise<unknown> {
    const plan = await this.Plan(operation, ref, value, policy, mode, objectID);
    if (mode === "init" && operation !== "read") return plan;
    return this.Apply(plan);
  }

  private checkCatalog(plan: CloudPlan, catalog: CapabilityCatalog): void {
    validateCapabilities(plan, catalog);
  }

  /** Apply a reviewed plan. Never silently recompile a reviewed init diff. */
  async Apply(plan: CloudPlan): Promise<unknown> {
    const adapter = this.requireAdapter();
    this.checkCatalog(plan, await adapter.capabilities());
    await adapter.validate(plan);
    if (plan.ir.mode === "init") {
      if (plan.ir.operation === "read") {
        if (!adapter.inspect) throw new Error("Init.Read requires adapter.inspect");
        return adapter.inspect(plan.ir);
      }
      if (!adapter.reconcile || !plan.observation || !plan.changes) throw new Error("Init Apply requires an inspected diff; plan again with an adapter");
      const result = await adapter.reconcile(plan);
      for (const seed of plan.seeds ?? []) await this.Apply(seed);
      return result;
    }
    const envelope: JobEnvelope = { version: 1, plan, idempotencyKey: plan.ir.policy.idempotencyKey ?? plan.id };
    if (plan.route === "queue" || plan.route === "workflow") {
      const submit = plan.route === "queue" ? adapter.enqueue : adapter.startWorkflow;
      if (!submit) throw new Error(`Adapter does not implement ${plan.route} dispatch`);
      const accepted = await submit.call(adapter, envelope);
      if (!accepted || typeof accepted.jobID !== "string" || !accepted.jobID) throw new Error("Adapter accepted no durable jobID");
      return { jobID: accepted.jobID, status: "queued", via: plan.route, planID: plan.id } satisfies JobReceipt;
    }
    return this.run(plan);
  }

  /** Worker entry point after durable dispatch; preserves identity and idempotency. */
  async Resume(envelope: JobEnvelope): Promise<unknown> {
    if (envelope.version !== 1 || envelope.plan.ir.mode !== "runtime") throw new Error("Unsupported job envelope");
    const adapter = this.requireAdapter();
    this.checkCatalog(envelope.plan, await adapter.capabilities());
    await adapter.validate(envelope.plan);
    // Adapter workers own deduplication/checkpoint state keyed by this envelope.
    return this.run(envelope.plan);
  }

  private async run(plan: CloudPlan): Promise<unknown> {
    const adapter = this.requireAdapter();
    if (plan.ir.objectID || plan.ir.operation === "object") {
      if (!adapter.invokeObject) throw new Error("Coordinated identity requires adapter.invokeObject");
      return adapter.invokeObject(plan);
    }
    const results = new Map<string, unknown>();
    let previous: unknown;
    let result: unknown;
    let authority: AuthorityResult | undefined;
    for (const step of plan.steps) {
      if (step.onMissOf) {
        const cached = results.get(step.onMissOf) as CacheEntry;
        if (cached.hit) { results.set(step.id, undefined); continue; }
      }
      const input = step.input === "value" ? plan.ir.value : step.input === "previous"
        ? step.inputFrom ? stepValue(results.get(step.inputFrom)) : previous
        : step.input === "query" ? plan.ir.policy.similar ?? plan.ir.policy.query : undefined;
      const output = await adapter.execute({ plan, step, input, results, authority });
      results.set(step.id, output);
      if (["database", "storage"].includes(step.capability) && ["get", "upsert"].includes(step.action) && isAuthorityResult(output)) {
        authority = output;
      }
      if (step.capability === "cache" && step.action === "get") {
        if (!output || typeof (output as CacheEntry).hit !== "boolean") throw new Error("cache.get must return CacheEntry");
        if ((output as CacheEntry).hit) result = (output as CacheEntry).value;
        previous = (output as CacheEntry).value;
      } else if (step.capability !== "cache" && step.capability !== "index" || step.action.startsWith("search")) {
        previous = stepValue(output);
        result = previous;
      }
      // Cache/index maintenance acknowledgments must not replace authoritative data.
    }
    return plan.ir.operation === "write" ? plan.ir.value : result;
  }
}

export function compose(context: CloudIR | CompositionContext, makeID: () => string = uid): CloudPlan {
    const ir: CloudIR = "version" in context ? context : {
      version: 1, ...context,
      policy: { ...policyForRequirements(context.requirements), ...context.policy },
      objectID: context.objectID ?? (context.requirements.coordinated ? context.ref : undefined),
    };
    const r = ir.requirements;
    const required = new Set<Capability>();
    const steps: Step[] = [];
    let valueStep: string | undefined;
    const add = (capability: Capability, action: string, input: Step["input"] = "none", onMissOf?: string) => {
      required.add(capability);
      const id = `s${steps.length + 1}`;
      const preceding = steps.at(-1)?.id;
      steps.push({ id, capability, action, input, onMissOf,
        dependsOn: preceding ? [preceding] : [],
        inputFrom: input === "previous" ? valueStep : undefined });
      if (capability === "cache" && action === "get" || capability !== "cache" && capability !== "index" || action.startsWith("search")) valueStep = id;
      return id;
    };
    const authority: Capability = authorityFor(ir.shape, r);
    // Read/Delete recover original shape via describe or a CloudRef shape policy.
    // No provider storage destination leaks into the application API.
    const search = enabled(r.searchable), semantic = enabled(r.semantic);
    if (r.durability === "ephemeral" &&
      (search || semantic || ir.policy.query !== undefined || ir.policy.similar !== undefined)) {
      throw new Error("Indexed records require a persistent authoritative source");
    }
    if (ir.mode === "init" && ir.operation === "write" && !ir.contract?.think && !ir.contract?.process &&
      r.durability === "ephemeral" && r.speed !== "fast") throw new Error("Ephemeral data requires fast:true (cache); no implicit persistence");
    if (ir.mode === "init" && (ir.operation === "read" || ir.operation === "delete")) {
      // Observation and absence target the whole subject; inspect/diff discovers
      // existing bindings, including capabilities absent from the new defaults.
    } else if (ir.mode === "init") {
      if (ir.operation === "think" || ir.contract?.think) required.add("mind");
      else if (ir.operation === "process" || ir.contract?.process) required.add("processor");
      else if (ir.operation === "object") required.add("object");
      else if (r.durability === "persistent") required.add(authority);
      if (r.speed === "fast") required.add("cache");
      if (search || semantic) required.add("index");
      if (semantic) required.add("mind");
    } else if (ir.operation === "think") add("mind", "think", "value");
    else if (ir.operation === "process") add("processor", "run", "value");
    else if (ir.operation === "object") required.add("object");
    else if (ir.operation === "write") {
      if (r.durability === "persistent") add(authority, "upsert", "value");
      else if (r.speed !== "fast") throw new Error("Ephemeral data requires fast:true (cache); no implicit persistence");
      if (r.speed === "fast") {
        // A cache-only write has no authority to reload, so it must populate cache.
        add("cache", r.cache === "write-through" || r.durability === "ephemeral" ? "put" : "invalidate", "value");
      }
      if (search) add("index", "upsert", "value");
      if (semantic) { add("mind", "embed", "value"); add("index", "upsertVector", "previous"); }
    } else if (ir.operation === "read") {
      if (ir.policy.similar !== undefined || ir.policy.query !== undefined) {
        if (ir.policy.similar !== undefined) add("mind", "embedQuery", "query");
        add("index", ir.policy.similar !== undefined ? "searchVector" : "search", ir.policy.similar !== undefined ? "previous" : "query");
        add(authority, "hydrate", "previous");
      } else {
        const cache = r.speed === "fast" && r.freshness === "stale-ok" ? add("cache", "get") : undefined;
        if (r.durability === "persistent") {
          add(authority, "get", "none", cache);
          if (r.speed === "fast") add("cache", "put", "previous", cache);
        } else if (!cache) throw new Error("Fresh reads require an authoritative persistent source");
      }
    } else if (ir.operation === "delete") {
      if (r.durability === "persistent") add(authority, "delete");
      if (r.speed === "fast") add("cache", "invalidate");
      if (search || semantic) add("index", "delete");
      if (!steps.length) throw new Error("Delete has no state capability to target");
    }
    // Defaults on Write and Read must be consistent. CloudRef preserves schema and
    // policy across operations; adapters should persist subject metadata as well.
    if (ir.objectID) required.add("object");
    const observeOrRemove = ir.mode === "init" && (ir.operation === "read" || ir.operation === "delete");
    const route = observeOrRemove ? "inline" : r.workflow ? "workflow" : r.execution === "deferred" ? "queue" : ir.objectID ? "object" : "inline";
    if (route === "workflow") required.add("workflow");
    if (route === "queue") required.add("queue");
    return { version: 1, id: makeID(), ir, required: [...required], steps, route };
  }


export default CloudC;

type WireValue = null | string | number | boolean | {
  t: "undefined" | "bigint" | "date" | "binary" | "blob" | "ref" | "array" | "object";
  v?: string | WireValue[] | [string, WireValue][];
  mime?: string;
};

async function toWire(value: unknown): Promise<WireValue> {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cloud cannot encode a non-finite number");
    return value;
  }
  if (typeof value === "undefined") return { t: "undefined" };
  if (typeof value === "bigint") return { t: "bigint", v: value.toString() };
  if (value instanceof Date) return { t: "date", v: value.toISOString() };
  if (value instanceof CloudRef) return { t: "ref", v: [value.id, await toWire(value.policy)] };
  if (value instanceof ArrayBuffer) return { t: "binary", v: bytesToBase64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    return { t: "binary", v: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return { t: "blob", v: bytesToBase64(new Uint8Array(await value.arrayBuffer())), mime: value.type };
  }
  if (Array.isArray(value)) return { t: "array", v: await Promise.all(value.map(toWire)) };
  if (!value || typeof value !== "object") throw new TypeError("Cloud only encodes portable values");
  const entries: [string, WireValue][] = [];
  for (const [key, item] of Object.entries(value)) entries.push([key, await toWire(item)]);
  return { t: "object", v: entries };
}

function fromWire(value: WireValue): unknown {
  if (value === null || typeof value !== "object") return value;
  switch (value.t) {
    case "undefined": return undefined;
    case "bigint": return BigInt(value.v as string);
    case "date": return new Date(value.v as string);
    case "binary": return base64ToBytes(value.v as string).buffer;
    case "blob": return new Blob([base64ToBytes(value.v as string)], { type: value.mime });
    case "ref": {
      const [id, policy] = (value.v as WireValue[]).map(fromWire);
      return new CloudRef(id as string, policy as Policy);
    }
    case "array": return (value.v as WireValue[]).map(fromWire);
    case "object": return Object.fromEntries((value.v as [string, WireValue][]).map(([key, item]) => [key, fromWire(item)]));
  }
}

export async function encodeValue(value: unknown): Promise<string> {
  return JSON.stringify(await toWire(value));
}
export function decodeValue(value: string): unknown {
  return fromWire(JSON.parse(value) as WireValue);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function expiration(now: number, ttl: number | null): number | null {
  return ttl === null ? null : now + ttl;
}
export function fieldsEnabled(fields: Fields | undefined): boolean {
  return fields === true || Array.isArray(fields) && fields.length > 0;
}
export function isExpired(expiresAt: number | null | undefined, now: number): boolean {
  return expiresAt !== null && expiresAt !== undefined && expiresAt <= now;
}
export function retainedPolicy(policy: Policy): SubjectManifest["policy"] {
  const result: SubjectManifest["policy"] = {};
  for (const key of ["persistent", "fast", "searchable", "semantic", "ttl", "coordinated"] as const) {
    if (policy[key] !== undefined) (result as Record<string, unknown>)[key] = policy[key];
  }
  return result;
}
export function stableJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${stableJSON((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export function selectedFields(value: unknown, fields: Fields): Record<string, Scalar> {
  if (fields === false) return {};
  const result: Record<string, Scalar> = {};
  if (fields === true) {
    collectScalars(value, "", result);
    return result;
  }
  for (const path of fields) {
    const item = getPath(value, path);
    if (item !== undefined && (item === null || ["string", "number", "boolean"].includes(typeof item))) result[path] = item as Scalar;
  }
  return result;
}
function collectScalars(value: unknown, prefix: string, result: Record<string, Scalar>): void {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    result[prefix || "value"] = value as Scalar;
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, item] of Object.entries(value)) collectScalars(item, prefix ? `${prefix}.${key}` : key, result);
}
function getPath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}
export function textFor(value: unknown, fields: Fields): string {
  if (fields === true) return flattenText(value).join("\n");
  const selected = selectedFields(value, fields);
  if (Object.keys(selected).length) return Object.values(selected).map(item => item === null ? "" : String(item)).join("\n");
  return "";
}
function flattenText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(flattenText);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenText);
  return [];
}
export function normalizeSearchQuery(query: unknown): Required<SearchQuery> {
  if (typeof query === "string") return { text: query, where: {}, limit: 20 };
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new TypeError("query must be text or { text?, where?, limit? }");
  const source = query as Record<string, unknown>;
  for (const key of Object.keys(source)) if (!["text", "where", "limit"].includes(key)) throw new TypeError(`Unsupported query option: ${key}`);
  if (source.text !== undefined && typeof source.text !== "string") throw new TypeError("query.text must be a string");
  const where = source.where ?? {};
  if (!where || typeof where !== "object" || Array.isArray(where)) throw new TypeError("query.where must be a field map");
  for (const [key, value] of Object.entries(where)) {
    if (!key || !(value === null || ["string", "number", "boolean"].includes(typeof value))) throw new TypeError(`Unsupported query.where value for ${key}`);
  }
  const limit = source.limit ?? 20;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new TypeError("query.limit must be an integer from 1 to 100");
  return { text: source.text as string ?? "", where: where as Record<string, Scalar>, limit: limit as number };
}
function shapeField(shape: Shape, path: string): Shape | undefined {
  let cursor: Shape | undefined = shape;
  for (const part of path.split(".")) cursor = cursor?.kind === "record" ? cursor.fields?.[part] : undefined;
  return cursor;
}
export function assertValueMatchesShape(value: unknown, shape: Shape, path = "value"): void {
  const fail = (expected: string): never => { throw new TypeError(`${path} must match ${expected}`); };
  switch (shape.kind) {
    case "unknown": return;
    case "null": if (value !== null) fail("null"); return;
    case "string": if (typeof value !== "string") fail("string"); return;
    case "number": if (typeof value !== "number" || !Number.isFinite(value)) fail("finite number"); return;
    case "boolean": if (typeof value !== "boolean") fail("boolean"); return;
    case "bigint": if (typeof value !== "bigint") fail("bigint"); return;
    case "undefined": if (value !== undefined) fail("undefined"); return;
    case "datetime": if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("datetime"); return;
    case "blob": {
      const blob = value instanceof ArrayBuffer || ArrayBuffer.isView(value) || typeof Blob !== "undefined" && value instanceof Blob;
      if (!blob) fail("blob");
      return;
    }
    case "ref": if (!(value instanceof CloudRef)) fail("CloudRef"); return;
    case "array": {
      if (!Array.isArray(value)) fail("array");
      if (shape.items) (value as unknown[]).forEach((item, index) => assertValueMatchesShape(item, shape.items!, `${path}[${index}]`));
      return;
    }
    case "record": {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("record");
      const record = value as Record<string, unknown>;
      const fields = shape.fields ?? {};
      for (const [key, field] of Object.entries(fields)) {
        if (!Object.hasOwn(record, key)) {
          if (!field.optional) throw new TypeError(`${path}.${key} is required`);
        } else assertValueMatchesShape(record[key], field, `${path}.${key}`);
      }
      for (const key of Object.keys(record)) if (!Object.hasOwn(fields, key)) throw new TypeError(`${path}.${key} is not declared in the shape`);
      return;
    }
    case "union": {
      for (const variant of shape.variants ?? []) {
        try { assertValueMatchesShape(value, variant, path); return; } catch { /* try the next variant */ }
      }
      fail("one of the declared union variants");
    }
  }
}
export function validateSelectedFields(name: string, fields: Fields, shape: Shape, stringOnly: boolean): void {
  if (!Array.isArray(fields)) return;
  for (const field of fields) {
    const selected = shapeField(shape, field);
    if (!selected) throw new TypeError(`${name} field is absent from shape: ${field}`);
    const allowed = stringOnly ? selected.kind === "string" : ["string", "number", "boolean", "null"].includes(selected.kind);
    if (!allowed) throw new TypeError(`${name} field has an unsupported ${selected.kind} shape: ${field}`);
  }
}
export function clonePlanWithoutObject(plan: CloudPlan): CloudPlan {
  const { objectID: _objectID, ...ir } = plan.ir;
  return { ...plan, ir: { ...ir, policy: { ...ir.policy, coordinated: false },
    requirements: { ...ir.requirements, coordinated: false } },
    required: plan.required.filter(capability => capability !== "object"), route: "inline" };
}


export type Scalar = string | number | boolean | null;
export interface SearchQuery { text?: string; where?: Record<string, Scalar>; limit?: number; }
export interface SubjectManifest { version: 1; subject: string; shape: Shape; policy: NonNullable<SubjectDescription["policy"]>; required: Capability[]; }

export type CloudOperation = Operation;
export type CloudServiceKind = Capability;
export type CloudShape = Shape;
export type CloudFieldShape = Shape;
export type CloudRequirements = Requirements;
export type FieldSelection = Fields;
export type CloudPlanStep = Step;
export type CloudJob = JobEnvelope;
export type ProviderCapabilities = CapabilityCatalog;

export interface CompositionContext {
  mode: Mode;
  operation: Operation;
  ref: string;
  shape: Shape;
  requirements: Requirements;
  value?: unknown;
  objectID?: string;
  policy?: Policy;
  contract?: InitContract;
}

/** Coordination selects a boundary; it never silently relocates authority. */
export function authorityFor(shape: Shape, requirements: Requirements): "database" | "storage" | "cache" {
  if (requirements.durability === "ephemeral" && requirements.speed === "fast") return "cache";
  return shape.kind === "blob" ? "storage" : "database";
}

export interface CloudLifetime { ttlMs?: number; expiresAt?: string; }
export interface CloudRequirementInput {
  speed?: "normal" | "default" | "fast";
  durability?: Requirements["durability"];
  consistency?: "eventual" | "fresh" | "realtime" | "strong";
  freshness?: Requirements["freshness"];
  execution?: "now" | "later" | "deferred";
  lifetime?: number | null | CloudLifetime;
  search?: { lexical?: Fields; semantic?: Fields };
  coordinated?: boolean;
  workflow?: boolean | string;
  fast?: boolean;
  persistent?: boolean;
  ephemeral?: boolean;
  fresh?: boolean;
  realtime?: boolean;
  now?: boolean;
  later?: boolean;
  searchable?: Fields;
  semantic?: Fields;
  global?: boolean;
  cheap?: boolean;
}

export const DEFAULT_REQUIREMENTS: Readonly<Requirements> = Object.freeze(normalizePolicy({ persistent: true }).requirements);

/** One-time translation of friendly inputs into the single executable vocabulary. */
export function normalizeRequirements(input: CloudRequirementInput = {}, now = Date.now() / 1000): Requirements {
  if (input.persistent && input.ephemeral) throw new TypeError("persistent conflicts with ephemeral");
  if (input.now && input.later) throw new TypeError("now conflicts with later");
  const lifetime = input.lifetime;
  let ttl: number | undefined;
  if (typeof lifetime === "number") ttl = lifetime;
  else if (lifetime) {
    if (lifetime.ttlMs !== undefined && lifetime.expiresAt !== undefined) throw new TypeError("Choose ttlMs or expiresAt");
    if (lifetime.ttlMs !== undefined) ttl = lifetime.ttlMs / 1000;
    else if (lifetime.expiresAt !== undefined) {
      const expires = Date.parse(lifetime.expiresAt) / 1000;
      if (!Number.isFinite(expires) || expires <= now) throw new TypeError("expiresAt must be a future date");
      ttl = expires - now;
    }
  }
  if (input.speed !== undefined && !["normal", "default", "fast"].includes(input.speed)) throw new TypeError("Invalid speed");
  if (input.durability !== undefined && !["ephemeral", "persistent"].includes(input.durability)) throw new TypeError("Invalid durability");
  if (input.consistency !== undefined && !["eventual", "fresh", "realtime", "strong"].includes(input.consistency)) throw new TypeError("Invalid consistency");
  if (input.execution !== undefined && !["now", "later", "deferred"].includes(input.execution)) throw new TypeError("Invalid execution");
  return normalizePolicy({
    persistent: input.ephemeral ? false : input.persistent ?? input.durability !== "ephemeral",
    fast: input.fast ?? input.speed === "fast",
    fresh: input.fresh ?? (input.freshness === "fresh" || input.consistency === "fresh"),
    realtime: input.realtime ?? (input.consistency === "realtime" || input.consistency === "strong"),
    deferred: input.now === true ? false : input.later || input.now === false || input.execution === "later" || input.execution === "deferred",
    ttl, searchable: input.searchable ?? input.search?.lexical,
    semantic: input.semantic ?? input.search?.semantic,
    coordinated: input.coordinated, workflow: input.workflow,
    global: input.global, cheap: input.cheap,
  }).requirements;
}

export function policyForRequirements(requirements: Requirements): Policy {
  return {
    persistent: requirements.durability === "persistent", fast: requirements.speed === "fast",
    fresh: requirements.freshness === "fresh", realtime: requirements.consistency === "strong",
    deferred: requirements.execution === "deferred", ttl: requirements.lifetime ?? 0,
    searchable: requirements.searchable, semantic: requirements.semantic,
    coordinated: requirements.coordinated, workflow: requirements.workflow,
    global: requirements.global, cheap: requirements.cheap,
  };
}

function isAuthorityResult(value: unknown): value is AuthorityResult {
  return !!value && typeof value === "object" && (value as AuthorityResult).kind === "authority" && typeof (value as AuthorityResult).hit === "boolean";
}
function stepValue(value: unknown): unknown {
  return isAuthorityResult(value) ? value.value : value;
}

/** Shared capability constraints also apply to Init's desired potential. */
export function validateCapabilities(plan: CloudPlan, catalog: CapabilityCatalog): void {
  for (const capability of plan.required) {
    const descriptor = catalog[capability];
    if (!descriptor || !descriptor.actions.length && !descriptor.provisionable) throw new Error(`Missing capability: ${capability}`);
    for (const step of plan.steps.filter(step => step.capability === capability)) {
      if (!descriptor.actions.includes(step.action)) throw new Error(`Unsupported capability action: ${capability}.${step.action}`);
    }
    const state = ["database", "storage", "cache", "index"].includes(capability);
    const r = plan.ir.requirements;
    if (r.global && !descriptor.global) throw new Error(`${capability} cannot guarantee global placement`);
    if (r.cheap && !descriptor.cheap) throw new Error(`${capability} cannot guarantee cheap placement`);
    if (["database", "storage"].includes(capability) && r.durability === "persistent" && !descriptor.persistent) throw new Error(`${capability} cannot guarantee persistence`);
    if (state && r.consistency === "strong" && !descriptor.strong) throw new Error(`${capability} cannot guarantee strong consistency`);
    if (["database", "storage", "cache"].includes(capability) && r.lifetime !== null) {
      if (!descriptor.ttl) throw new Error(`${capability} cannot enforce lifetime`);
      if (r.lifetime < (descriptor.minimumTTL ?? 0)) throw new Error(`${capability} TTL must be at least ${descriptor.minimumTTL} seconds`);
    }
  }
  const visited = new Set<string>();
  for (const step of plan.steps) {
    if (visited.has(step.id)) throw new Error(`Duplicate plan step: ${step.id}`);
    for (const id of [...(step.dependsOn ?? []), ...(step.inputFrom ? [step.inputFrom] : []), ...(step.onMissOf ? [step.onMissOf] : [])]) {
      if (!visited.has(id)) throw new Error(`Step ${step.id} requires an earlier step: ${id}`);
    }
    if (!plan.required.includes(step.capability)) throw new Error(`Undeclared capability: ${step.capability}`);
    if (step.onMissOf && !plan.steps.some(source => source.id === step.onMissOf && source.capability === "cache" && source.action === "get")) throw new Error(`Invalid cache miss source: ${step.onMissOf}`);
    visited.add(step.id);
  }
  if (plan.route !== "inline" && !plan.required.includes(plan.route)) throw new Error(`Undeclared dispatch capability: ${plan.route}`);
}

/** Service ports receive the full contract, including commit metadata. */
export interface DatabaseService {
  get(context: StepContext): Promise<AuthorityResult>;
  upsert(context: StepContext): Promise<AuthorityResult>;
  hydrate(context: StepContext): Promise<unknown[]>;
  delete(context: StepContext): Promise<void>;
}
export type StorageService = DatabaseService;
export interface CacheService {
  get(context: StepContext): Promise<CacheEntry>;
  put(context: StepContext): Promise<void>;
  invalidate(context: StepContext): Promise<void>;
}
export interface IndexService {
  upsert(context: StepContext): Promise<void>;
  search(context: StepContext): Promise<IndexHit[]>;
  delete(context: StepContext): Promise<void>;
  upsertVector?(context: StepContext): Promise<void>;
  searchVector?(context: StepContext): Promise<IndexHit[]>;
}
export interface MindService {
  think(context: StepContext): Promise<unknown>;
  embed(context: StepContext): Promise<number[]>;
  embedQuery(context: StepContext): Promise<number[]>;
}
export interface ProcessorService { run(context: StepContext): Promise<unknown>; }
export interface QueueService { enqueue(envelope: JobEnvelope): Promise<{ jobID: string }>; }
export interface WorkflowService { start(envelope: JobEnvelope): Promise<{ jobID: string }>; }
export interface ObjectService { invoke(plan: CloudPlan): Promise<unknown>; }
export interface CloudProviderServices {
  database?: DatabaseService; storage?: StorageService; cache?: CacheService;
  index?: IndexService; mind?: MindService; processor?: ProcessorService;
  queue?: QueueService; workflow?: WorkflowService; object?: ObjectService;
}

/** Abstract conductor: common reasoning with provider-specific execution ports. */
export abstract class CloudProvider implements CloudAdapter {
  abstract readonly id: string;
  abstract readonly services: CloudProviderServices;
  abstract capabilities(): CapabilityCatalog;
  protected abstract validateProviderPlan(plan: CloudPlan): Promise<void> | void;
  protected async beforeExecute(): Promise<void> {}

  async validate(plan: CloudPlan): Promise<void> {
    if (plan.version !== 1 || plan.ir.version !== 1) throw new Error("Unsupported Cloud plan version");
    validateCapabilities(plan, this.capabilities());
    const { ir } = plan;
    if (ir.mode === "runtime" && ["write", "think", "process"].includes(ir.operation)) {
      reflectShape(ir.value); // Validate portability even when an explicit shape was supplied.
      if (ir.operation === "write") assertValueMatchesShape(ir.value, ir.shape);
    }
    validateSelectedFields("searchable", ir.requirements.searchable, ir.shape, false);
    validateSelectedFields("semantic", ir.requirements.semantic, ir.shape, true);
    if (fieldsEnabled(ir.requirements.semantic) && !this.capabilities().index?.actions.includes("upsertVector")) throw new Error("Semantic intent requires vector indexing");
    if (ir.policy.query !== undefined) {
      const query = normalizeSearchQuery(ir.policy.query);
      if (Array.isArray(ir.requirements.searchable)) for (const field of Object.keys(query.where)) {
        if (!ir.requirements.searchable.includes(field)) throw new TypeError(`query.where field is not searchable: ${field}`);
      }
    }
    await this.validateProviderPlan(plan);
  }

  async execute(context: StepContext): Promise<unknown> {
    await this.beforeExecute();
    const service = this.services[context.step.capability];
    const action = (service as unknown as Record<string, ((context: StepContext) => Promise<unknown>) | undefined> | undefined)?.[context.step.action];
    if (!action) throw new Error(`Unsupported capability action: ${context.step.capability}.${context.step.action}`);
    return action.call(service, context);
  }

  enqueue(envelope: JobEnvelope): Promise<{ jobID: string }> {
    if (!this.services.queue) throw new Error("Queue dispatch is unavailable");
    return this.services.queue.enqueue(envelope);
  }
  startWorkflow(envelope: JobEnvelope): Promise<{ jobID: string }> {
    if (!this.services.workflow) throw new Error("Workflow dispatch is unavailable");
    return this.services.workflow.start(envelope);
  }
  invokeObject(plan: CloudPlan): Promise<unknown> {
    if (!this.services.object) throw new Error("Object coordination is unavailable");
    return this.services.object.invoke(plan);
  }
}
