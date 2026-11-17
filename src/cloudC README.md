# CloudC - (aka Cloud Compiler): Developer Guide

Written for human developers and software agents implementing applications, compiler changes, and providers.

CloudC compiles application intent into provider-neutral capability compositions. An application requests durable state, fast reads, semantic retrieval, deferred computation, or coordination around an identity.
CloudC produces an inspectable plan; a provider implements the required capabilities and guarantees.

```text
verb + identity + value/contract + policy
                    |
          normalize policy and shape
                    |
                 Cloud IR
                    |
            compose capabilities
                    |
            validate the plan
                    |
           apply through provider
```

The same engine operates in two modes: runtime changes actual state; `Init` describes the capabilities that must exist to make those operations possible. Init mutations produce plans for explicit application.

## Read this first

- Application authors: start with [quick start](#quick-start), [public API](#public-api), and [policy](#policy-and-requirements).
- Provider authors: read [execution contracts](#execution-and-provider-contracts) and [failure semantics](#failure-semantics).
- Compiler contributors and coding agents: read [source status](#source-status-and-design-history), [composition rules](#composition-rules), and [development guidance](#development-guidance).

### Source status and design history

These files currently expose different generations of the design. Their similarly named types are not interchangeable.

| File | Role in this checkout |
| --- | --- |
| [`cloud.brainstorm.md`](../docs/cloud.brainstorm.md) | Design progression, rationale, and proposed capabilities. Examples include earlier syntax and future ideas. |
| [`cloudC-model.ts`](./cloudC-model.ts) | Earlier standalone ontology, normalization, composition catalog, and generic service interfaces. |
| [`cloudC.ts`](./cloudC.ts) | Executable compiler and runtime, public `CloudC` API, IR, plan validation, codecs, service ports, and abstract `CloudProvider`. |
| [`cloudflare.ts`](./adapters/cloudflare.ts) | Cloudflare provider for the executable runtime, with D1 and other Worker bindings. |
| [`landcloud.ts`](./adapters/landcloud.ts) | Bun SQLite provider for CloudC's structured records and SQL search. |
| [`cloudflare-provider.ts`](./adapters/cloudflare-provider.ts) | Earlier provider implementation using the standalone model's service interfaces. |
| [`worker.example.ts`](../examples/worker.example.ts) | Worker example that wires CloudC to Cloudflare bindings. |

**Import the executable API from `endgo/cloudC` in a package consumer.** Import providers from `endgo/adapters/landcloud` and `endgo/adapters/cloudflare` at the runtime entry points. The [portable storage example](../examples/portable-storage/README.md) runs one app on Bun SQLite and Wrangler's local D1.

The brainstorm established several principles that remain central:

1. Application code expresses requirements; provider code owns credentials, resource names, protocols, and infrastructure calls.
2. Reflection discovers structure. Search, AI, durability, and coordination require declared intent.
3. Cache and index are projections of persistent authority. Index hits must be hydrated from authority.
4. `Init` is a mode of the same model, rather than a separate infrastructure language.
5. Unsupported guarantees must fail explicitly instead of being silently weakened.

Some proposals evolved. In particular, `cloudC.ts` makes an object a coordination boundary without relocating database/storage authority. It separates freshness from strong consistency, and implements fixed composition rules plus capability checks. Candidate-plan optimization, automatic SQL schema design, and API-key-only resource provisioning remain design directions.

## Quick start

### Compile a plan without a provider

This example makes no provider calls and performs no mutations:

```ts
import CloudC from "./cloudC.ts";

const cloud = new CloudC({ id: () => "example-plan" });
const article = { title: "Cloud compiler", body: "Portable application intent" };

const plan = await cloud.Plan("write", "article:123", article, {
  persistent: true,
  fast: true,
  semantic: ["body"],
});

console.log(plan.required); // ["database", "cache", "mind", "index"]
console.log(plan.route);    // "inline"
console.log(plan.steps.map(s => `${s.capability}.${s.action}`));
// ["database.upsert", "cache.invalidate", "mind.embed", "index.upsertVector"]
```

The fixed ID is for a reproducible example. Normally Cloud uses `crypto.randomUUID()`; supply a unique-ID function if the host lacks it. Without a provider, `Plan`, `Shape`, `CloudRef`, and object-handle construction are available. Executing operations requires a provider.

### Establish a contract, then use it

This function accepts a compatible `CloudAdapter`. It requires manifest persistence and the Init inspection/reconciliation methods described below:

```ts
import CloudC, { type CloudAdapter } from "./cloudC.ts";

export async function initializeAndUse(adapter: CloudAdapter) {
  const cloud = new CloudC({ adapter });

  const plan = await cloud.Init.Write("article", {
    shape: {
      id: { type: "string", key: true },
      title: "string",
      body: "string",
    },
    persistent: true,
    fast: true,
    searchable: ["title"],
    semantic: ["body"],
    seed: [{
      ref: "article:welcome",
      value: { id: "welcome", title: "Welcome", body: "Start here" },
    }],
  });

  // Review plan.changes and plan.seeds in the application's deployment flow.
  // Calling Apply is the explicit mutation boundary.
  await cloud.Apply(plan);

  await cloud.Write("article:123", {
    id: "123", title: "Cloud compiler", body: "Portable application intent",
  }, { fresh: true });

  const article = await cloud.Read("article:123", { fresh: true });
  const matches = await cloud.Read("article", { similar: "portable infrastructure" });
  return { article, matches };
}
```

Mapping `article:123` to the subject `article` is a provider convention, implemented by `describe(ref)`, rather than parsing performed by Cloud. A provider without manifests needs callers to carry the contract in a reusable `CloudRef`.

## Public API

`Cloud` is an instance API with capitalized verbs. `Write` is an upsert of the supplied value; Cloud defines no partial-update/merge operation.

```ts
const cloud = new CloudC({
  provider,                  // CloudAdapter; `adapter` is an equivalent option
  defaults: { persistent: true },
  // id: () => uniqueID(),
});
```

Supply either `provider` or `adapter`; supplying different objects for both throws. Setting `defaults` replaces the constructor's default policy. For example, `{ defaults: { fast: true } }` makes data ephemeral unless a manifest, ref, or call adds persistence. Include `persistent: true` when that is the intended application default.

| Runtime method | Meaning and result |
| --- | --- |
| `Write(ref, value, policy?)` | Upsert; an inline write returns the supplied value after the steps complete. |
| `Read(ref, policy?)` | Fetch a value or execute a search; search returns hydrated values. Authority miss and other output conventions are provider-defined. |
| `Delete(ref, policy?)` | Delete state and maintain declared projections; no portable deletion count is specified. |
| `Think(ref, input, policy?)` | Invoke `mind.think`; task/model interpretation belongs to the provider. |
| `Process(ref, input, policy?)` | Invoke `processor.run`; `ref` names a registered computation, not an arbitrary function. |
| `Object(ref, policy?)` | Synchronously return an identity-bound facade; construction performs no remote I/O. |
| `Shape(value)` | Synchronously reflect a runtime value's structure. |

The asynchronous verbs return promises. Deferred/workflow execution returns a `JobReceipt` instead of the completed operation result. The public result types are largely `unknown`; applications validate or narrow their own domain results.

| Init method | Meaning and result |
| --- | --- |
| `Init.Write(ref, contract, policy?)` | Plan the desired subject capability contract. Returns `CloudPlan`. |
| `Init.Read(ref, policy?)` | Inspect actual capability state now. Returns `Observation`, including an optional revision. |
| `Init.Delete(ref, policy?)` | Plan removal of the subject's capability contract. The provider defines removal scope and destructive effects in the diff. |
| `Init.Think(ref, contract, policy?)` | Plan a mind contract; does not run inference. |
| `Init.Process(ref, contract, policy?)` | Plan a processor contract; does not execute user code. |
| `Init.Object(ref, policy?)` | Plan an object capability contract. Returns a promise for a plan, unlike runtime `Object`. |
| `Init.Shape(declaration)` | Synchronously normalize a shape declaration. |

An `InitContract` accepts policy fields plus `input`, `output`, `think`, `process`, and `seed`. Input/output declarations are normalized for validity, but the core does not install a processor, generate its implementation, or enforce its input/output contract at invocation time. Providers own those details. Only `Init.Write` accepts seeds, each shaped as `{ ref, value, policy? }` with an explicit stable ref.

Supporting APIs share the same engine:

```text
Plan(operation, ref, value?, policy?, mode?, objectID?) → Promise<CloudPlan>
Apply(plan) → Promise<unknown>
Resume(envelope) → Promise<unknown>
```

- `Plan` compiles without applying. With a provider it may read a manifest, inspect Init state, calculate a diff, and validate. Offline plans lack provider validation; offline Init plans also lack the inspected diff needed for application.
- `Apply` revalidates the supplied plan and executes or reconciles it. It does not silently recompile a reviewed Init plan.
- `Resume` executes the runtime plan accepted by a queue/workflow worker, bypassing dispatch so it does not enqueue itself again. It preserves object coordination when present.
- `Submit` is the public implementation hook used by mode views; ordinary application code uses the verbs.

## Policy and requirements

Policy is the public input language in `cloudC.ts`. The compiler normalizes it into the `Requirements` object stored at `plan.ir.requirements`.

### Accepted policy inputs

Use an object, one shorthand string, or an array of shorthand strings:

```ts
await cloud.Read("article:123", "fresh");
await cloud.Read("article:123", ["fast", "fresh"]);
await cloud.Write("preview:1", "temporary", {
  persistent: false, fast: true, ttl: 120,
});
```

Shorthand strings are exactly `fast`, `persistent`, `fresh`, `stale`, `realtime`, `async`, and `deferred`. Unknown keys and shorthand names throw.

| Policy field | Normalized meaning |
| --- | --- |
| `persistent: true` | Persistent authority; default for `new Cloud()` with no custom defaults. `false` requests ephemeral data. |
| `fast: true` | Include cache access/maintenance. It does not specify a latency SLA. |
| `fresh: true` | Use authoritative current data; with fast operations, use write-through/cache fill. |
| `stale: true` | Permit stale cache reads. `stale: false` requests freshness. |
| `realtime: true` | Freshness plus a strong-consistency requirement on involved state capabilities. Providers may reject the combination. |
| `async`, `asynchronous`, `deferred` | Any `true` value requests deferred execution through a queue, unless workflow routing takes precedence. |
| `ttl` | Nonnegative finite seconds; `0` means no expiration. Positive values become `requirements.lifetime`. |
| `searchable` | `true`, `false`, or field-name array for lexical indexing. An empty array disables it. |
| `semantic` | `true`, `false`, or field-name array for embedding/vector indexing. An empty array disables it. |
| `query` | Lexical query input, interpreted/validated by the provider. Mutually exclusive with `similar`. |
| `similar` | Text to embed and use for semantic retrieval. |
| `workflow` | `true` selects the name `"default"`; a nonempty string selects a workflow name. `false` disables it. |
| `coordinated: true` | Execute inside an identity-scoped coordination boundary. |
| `shape` | Explicit shape declaration, also used to recover authority on reads/deletes. |
| `model` | Provider-specific model selection; does not itself add a mind step. |
| `idempotencyKey` | Stable queue/workflow deduplication key; defaults to the plan ID. |
| `global`, `cheap` | Capability constraints; every required capability must advertise the requested guarantee. No cost/locality optimizer is implemented. |

`fresh`/`realtime` conflict with `stale: true`. `query` and `similar` cannot be supplied together. Policy flags do not cancel aliases: to override deferred defaults, clear every enabled deferred flag.

### Merge order and defaults

Policy merges shallowly, with later sources taking precedence:

```text
Cloud defaults
  < provider.describe(ref).policy                 [runtime data verbs only]
  < CloudRef policy
  < Init contract policy                          [Init contract verbs only]
  < per-call policy
```

An explicit `policy.shape` wins over the shape returned by `describe`. Otherwise, runtime reflects the value and Init uses an unknown shape. For a read/delete without a declaration or manifest, the value being reflected is `undefined`; Cloud cannot discover that an existing identity holds a blob.

With `new Cloud()` and no overrides, normalized requirements are:

```ts
const defaultRequirements = {
  coordinated: false,
  speed: "default",
  durability: "persistent",
  consistency: "eventual",
  freshness: "stale-ok",
  execution: "now",
  lifetime: null,
  cache: "none",
  searchable: false,
  semantic: false,
  workflow: false,
  global: false,
  cheap: false,
};
```

`normalizePolicy({})` alone yields ephemeral durability; the `Cloud` constructor supplies the persistence default. `normalizeRequirements()` separately defaults to persistence.

### Canonical requirements versus public policy

`cloudC.ts` also exports `normalizeRequirements(input, now?)` for compiler-level callers. It translates friendly inputs such as `speed`, `durability`, `consistency`, `execution`, `lifetime`, `search`, `ephemeral`, `now`, and `later` into executable `Requirements`:

```ts
import { normalizeRequirements } from "./cloudC.ts";

const requirements = normalizeRequirements({
  speed: "fast",
  consistency: "fresh",
  execution: "later",
  lifetime: { ttlMs: 120_000 },
  search: { semantic: ["body"] },
});
// freshness: "fresh", cache: "write-through", execution: "deferred",
// lifetime: 120, semantic: ["body"]
```

Those friendly keys are **not** accepted directly by `cloud.Write` or other public verbs. Use `{ fast: true, fresh: true, deferred: true, ttl: 120 }` there. Duration strings such as `"30d"`, lowercase verbs, `work`, `ifVersion`, and an `authority` override appear in design discussion but are not executable public API.

The helper also accepts `lifetime: { expiresAt: "..." }` with a future date; its optional `now` argument is Unix seconds. Choose either `ttlMs` or `expiresAt`, not both. Once normalized, lifetime is seconds or null.

## Identity, shape, and retained contracts

### CloudRef and coordinated objects

`CloudRef` carries a nonempty logical ID and reusable policy. It contains no physical provider locator. `With(policy)` returns a new ref with merged policy; the ref and its top-level policy are frozen, but nested policy values are not deeply frozen.

```ts
import { CloudRef } from "./cloudC.ts";

const media = new CloudRef("media:123", { persistent: true, shape: "blob" });
await cloud.Write(media, new Uint8Array([1, 2, 3]));
await cloud.Read(media);   // Retains blob authority without describe().
await cloud.Delete(media);

const room = cloud.Object("room:abc", { persistent: true, fast: true });
await room.Write({ title: "Design room" });
await room.Read({ fresh: true });
```

The object facade exposes `Write(value, policy?)`, `Read(policy?)`, `Delete(policy?)`, `Think(input, policy?)`, `Process(input, policy?)`, and `Shape(value)`. Calls carry the object's ID as `ir.objectID`; they still use database/storage/cache according to the data contract. The provider serializes execution around that identity. Object `Think` and `Process` use the object's ref as the operation ref; they have no separate task-name argument.

Use a manifest or a reusable ref for all operations on a subject. Supplying `fast` or search policy only on the first write does not establish an in-memory contract in Cloud. A later delete that omits that contract can omit projection cleanup.

### Reflection and declarations

`cloud.Shape(value)` reflects portable values. `cloud.Init.Shape(declaration)` normalizes explicit declarations. Supported executable kinds are `unknown`, `null`, `string`, `number`, `boolean`, `bigint`, `undefined`, `datetime`, `blob`, `record`, `array`, `union`, and `ref`.

- `Date` becomes `datetime`; `ArrayBuffer`, views, and `Blob` become `blob`; `CloudRef` becomes `ref`.
- Arrays retain heterogeneous item shapes as a union. Empty arrays have unknown items.
- Reflection rejects cycles, functions, symbols as values, non-finite numbers, invalid dates, custom class instances, and enumerable record getters.
- Reflection does not infer keys, lexical indexing, embeddings, or business meaning.
- Size is measured for strings and binary values where supported; it is not a transport/persistence encoding or a complete object-size estimate.
- Streams are discussed in the earlier model but are not a supported shape kind in `cloudC.ts`.

Declarations accept kind strings, `{ type: ... }`/`{ kind: ... }` descriptors, or bare field maps. Use an explicit record descriptor for maps containing reserved `type` or `kind` names:

```ts
const declaration = cloud.Init.Shape({
  kind: "record",
  fields: {
    type: "string",
    email: { type: "string", searchable: true },
    nickname: { type: "string", optional: true },
    tags: { type: "array", items: "string" },
  },
});
```

Top-level field `searchable: true` annotations become lexical intent if the policy has no explicit `searchable` selection. `key` is metadata for the provider; it does not replace the call's ref. Semantic intent is expressed through policy, not a semantic field annotation.

The abstract executable `CloudProvider` validates writes against declarations: required fields must exist, extra fields are rejected, optional fields may be absent, and unions must match a variant. Custom `CloudAdapter` implementations must provide their own full validation. A shape change is not automatic data migration.

`encodeValue`/`decodeValue` provide tagged serialization for portable values, including `undefined`, `bigint`, dates, binary, blobs, and refs. Binary views decode to an `ArrayBuffer`; typed-array constructor identity is not retained. Reflection/validation and encoding are separate responsibilities. Do not assume plain JSON preserves a plan or job's values.

## Composition rules

The executable compiler uses fixed patterns. It does not enumerate or rank candidate backends.

Authority is cache for ephemeral fast data, storage for persistent top-level blobs, and database for other persistent values. Ephemeral writes require `fast: true`; indexed/searchable data requires a persistent authoritative source. Coordination adds an execution boundary and never changes this authority choice.

In this table, `A` is database or storage. These are runtime steps; each row assumes the stated contract is retained for later calls.

| Operation and intent | Ordered steps |
| --- | --- |
| Persistent write | `A.upsert` |
| Persistent fast write, stale allowed | `A.upsert → cache.invalidate` |
| Persistent fast fresh write | `A.upsert → cache.put` |
| Ephemeral fast write | `cache.put` |
| Persistent read | `A.get` |
| Persistent fast read, stale allowed | `cache.get`; on miss only: `A.get → cache.put` |
| Persistent fast fresh read | `A.get → cache.put`; bypass cache read |
| Ephemeral fast read | `cache.get`; freshness requiring authority is rejected |
| Persistent delete | `A.delete`; add `cache.invalidate` when fast and `index.delete` when indexed |
| Ephemeral fast delete | `cache.invalidate` |
| Think | `mind.think` |
| Process | `processor.run` |

Lexical intent adds `index.upsert` after the write/cache steps. Semantic intent adds `mind.embed → index.upsertVector`. With both enabled, lexical maintenance precedes semantic maintenance.

Search reads bypass the record-cache path:

```text
Read(subject, { query })   : index.search → A.hydrate
Read(subject, { similar }) : mind.embedQuery → index.searchVector → A.hydrate
```

Index methods return `IndexHit[]` containing refs and optional scores. Hydration returns authoritative records; raw vector/index metadata is not the application result. Retrieval completeness and index visibility timing remain provider guarantees. The core does not automatically extract text, chunk a PDF, or schedule a processor for semantic blobs.

The shared `CloudProvider` query validator accepts a text string or `{ text?, where?, limit? }`. `where` is a map of scalar equality values, and `limit` is an integer from 1 through 100, defaulting to 20. Unknown options are rejected; when searchable fields are an explicit array, filter fields must be included. Providers must still validate and implement the complete query semantics.

Execution routing is orthogonal to the inline steps:

1. Init Read/Delete use the inline route to inspect/remove the existing subject contract.
2. Otherwise workflow takes precedence, followed by deferred queue execution, then object coordination, then inline execution.
3. The plan retains its full operation steps and required capabilities when queued. Queue/workflow dispatch is a route, not an additional executable step.
4. A resumed queued/workflow operation still enters object coordination when `ir.objectID` is present.

`fast` writes that allow staleness invalidate; this core does not schedule a background cache refresh. A later cache miss fills from authority. Write-through orders authority before cache and does not create a cross-service transaction.

Init uses the same requirements to collect required capabilities, with no runtime steps. Think/process/object establish their corresponding capability; data contracts establish authority/cache/index/mind as needed. Queue/workflow/coordination requirements are added by routing. Init Read/Delete leave `required` empty so the provider can inspect the full existing subject rather than infer it from today's defaults. An `Init.Object` plan establishes the object capability itself; declare a data contract separately when persistent state is also required.

## IR and plan reference

| Structure | Important fields |
| --- | --- |
| `CloudIR` | `version: 1`, mode, operation, logical ref, optional objectID, runtime value, normalized shape, expanded policy, canonical requirements, optional Init contract. |
| `CloudPlan` | `version: 1`, generated ID, IR, required capabilities, ordered steps, route, optional observation/changes/seeds. |
| `Step` | ID, capability, action, input selector, ordering dependencies, optional explicit data source and cache-miss branch. |
| `Observation` | Actual provider state and optional optimistic-concurrency revision. |
| `InitChange` | Capability, `create`/`modify`/`delete`/`noop`, optional before/after/details/destructive flag. |

`dependsOn` expresses ordering. `inputFrom` selects the earlier step whose value is consumed; the two are distinct. `onMissOf` runs a step only if an earlier `cache.get` missed. Inputs select the original value, a prior value, query input, or nothing. The current executor iterates steps sequentially; it is not a parallel DAG scheduler.

Shared validation rejects missing capabilities/actions, unsatisfied persistence/strong consistency/TTL/placement constraints, duplicate step IDs, forward or missing dependencies, undeclared step/route capabilities, and invalid cache-miss sources. Plans are mutable objects, not signed or immutable artifacts; application code must preserve the reviewed plan through application.

## Execution and provider contracts

Implement `CloudAdapter` directly or extend `CloudProvider` from `cloudC.ts`. `provider` and `adapter` are construction aliases for the same boundary. The abstract provider offers dispatch into typed service ports and shared value/shape/search validation; its concrete subclass supplies services, capability descriptors, and `validateProviderPlan`.

| Adapter method | Responsibility |
| --- | --- |
| `capabilities()` | Advertise supported actions and guarantees. Required. |
| `validate(plan)` | Reject unsupported complete contracts before execution. Required; must be read-only. |
| `execute(context)` | Execute one inline capability step. Required. |
| `describe(ref)` | Read a retained subject shape/policy. Needed for automatic contract inheritance. |
| `inspect(ir)` | Observe actual capability state, optionally with a revision. Needed for Init. |
| `diff(ir, required, current)` | Read-only actual/desired comparison, including migrations and destructive effects. Needed for Init mutation planning. |
| `reconcile(plan)` | Apply the inspected diff idempotently, checking revision and removal scope. Needed for Init application. |
| `enqueue(envelope)` | Durably accept queued work and return a stable job ID. Needed for queue routing. |
| `startWorkflow(envelope)` | Durably accept a workflow and return a stable job ID. Needed for workflow routing. |
| `invokeObject(plan)` | Execute the enclosed steps within the named identity's coordination boundary. Needed for object operations. |

`CapabilityCatalog` is a partial map over `cache`, `database`, `storage`, `index`, `mind`, `processor`, `queue`, `workflow`, and `object`. Each descriptor lists `actions` and may advertise `persistent`, `strong`, `ttl`, `minimumTTL`, `global`, `cheap`, and `provisionable`. A provisionable descriptor can support Init planning before installation; runtime steps still require their exact actions. Advertising an interface is insufficient if the provider cannot uphold its semantics.

`StepContext` contains the plan, current step, selected input, previous results, and optional exact authority metadata. Executable service actions are:

| Capability | Service actions/results |
| --- | --- |
| database, storage | `upsert → AuthorityResult`, `get → AuthorityResult`, `hydrate → unknown[]`, `delete → void` |
| cache | `get → CacheEntry`, `put → void`, `invalidate → void` |
| index | `upsert`, `delete`; `search → IndexHit[]`; optional `upsertVector` and `searchVector → IndexHit[]` |
| mind | `think → unknown`, `embed → number[]`, `embedQuery → number[]` |
| processor | `run → unknown` |
| queue, workflow, object | Separate envelope/plan dispatch ports, rather than ordinary inline steps |

Cache results require an explicit hit discriminant, because all JavaScript values, including `undefined`, may be cached:

```ts
type CacheEntry = { hit: boolean; value?: unknown; stale?: boolean };
type AuthorityResult = {
  kind: "authority";
  hit: boolean;
  value?: unknown;
  version?: string;
  expiresAt: number | null; // Absolute Unix seconds; null means no expiration.
};
```

Cache providers must return `hit: false` for entries they cannot serve under the contract; the executor branches on `hit`, not the optional `stale` flag. Authority wrappers are unwrapped for application results. Cache/index maintenance acknowledgments do not replace the authoritative value. Exact authority metadata travels to subsequent projections so a cache fill does not restart the source TTL or detach the value from its commit version.

Persist manifests across restarts. The retained policy fields are `persistent`, `fast`, `searchable`, `semantic`, `ttl`, and `coordinated`; per-call freshness/execution flags are excluded. Keep provider locators and credentials inside the provider. Start structured persistence with an encoded document/envelope; deliberately implement field promotion and migrations rather than creating SQL tables from observed runtime records.

### Deferred jobs and workflows

```ts
const job = await cloud.Process("resizeImage", { image: "media:123" }, {
  async: true,
  idempotencyKey: "resize:media:123:v1",
});
// { jobID, status: "queued", via: "queue", planID }
```

The dispatch envelope is `{ version: 1, plan, idempotencyKey }`. It contains the full runtime plan and its value. Acceptance is durable acceptance of work, not completion. Consumers deserialize the envelope and call `cloud.Resume(envelope)` after acquiring their provider-specific deduplication/lease/checkpoint state.

The core has no generic job-status, result-fetch, retry scheduler, or completion store API. Providers/applications supply those. Deduplication must survive retries and restarts; reusing a key for a different logical operation is an application error. Workflow implementations must supply durable orchestration/checkpoints, not merely another queue label. The plan does not synthesize a multi-stage business workflow.

### Init reconciliation and seeds

Init mutation planning performs `inspect → diff → validate` and returns a plan. Application performs `validate → reconcile → apply seeds in order`. Review includes destructive changes, revision expectations, and the seed operations.

- Reconciliation must check the observation revision and reject stale plans rather than overwrite concurrent changes silently.
- Deleting a subject must not drop resources shared with other subjects. The provider must document whether its removal deletes manifests, projections, records, or a combination.
- Seeds are ordinary runtime upserts after reconciliation. Their policies inherit the parent contract with per-seed overrides; deferred/workflow flags are cleared. They are validated against installed capabilities when applied.
- Stable seed refs make repeated upserts address the same records. They do not make arbitrary side effects transactional.
- A seed failure may leave reconciliation and earlier seeds applied. Recovery/retry follows the provider's idempotency and migration rules.
- `Init` describes potential, but provisioning new cloud accounts/bindings/resources requires provider implementation. A binding-backed provider need not implement control-plane resource creation.

## Failure semantics

Cloud performs coarse shared checks and delegates full contract validation to the provider. `fresh` bypasses stale projections; `realtime` additionally requires strong state capabilities. Neither is a universal transaction mechanism. A provider must reject a combination whose guarantees it cannot deliver.

Authority commits precede cache/index maintenance. If a later step fails, the call can reject after the authoritative write has succeeded. There is no cross-capability rollback or exactly-once guarantee. Providers need versions/tombstones, retry logic, or an outbox to keep delayed projections from resurrecting deleted or superseded values. Hydrating index hits protects record correctness but does not make index discovery immediately complete.

Queue/workflow idempotency and identity serialization are provider responsibilities. The core does not implement application-level compare-and-set, multi-record transactions, or automatic conflict resolution. Init revision checks concern capability reconciliation rather than a runtime `ifVersion` API.

## The earlier cloud-model.ts API

Use this file to understand the original ontology or maintain consumers explicitly targeting it. It exports types, `DEFAULT_REQUIREMENTS`, `normalizeRequirements`, `COMPOSITION_PATTERNS`, `authorityFor`, and `compose`. It has no runtime engine, reflection helper, codecs, `CloudRef`, or abstract executable provider.

Its low-level composer takes `{ mode, operation, shape, requirements }` and returns `{ mode, operation, services, steps, returns, requirements, shape }`. Steps use `use`, optional `deferred`, and descriptive modes/metadata. Init composes runtime requirements into `ensure` steps. These are distinct from the executable plan's `ir`, `required`, route, and `capability`/input dependencies.

| Concern | `cloud-model.ts` | Executable `cloudC.ts` |
| --- | --- | --- |
| Speed | `normal` / `fast` | `default` / `fast` |
| Consistency | `eventual` / `fresh` / `realtime` | `eventual` / `strong`, plus separate freshness |
| Execution | `now` / `later` | `now` / `deferred` |
| Lifetime | `{ ttlMs?, expiresAt? }` | Canonical seconds or null; public policy uses `ttl` seconds |
| Search | `search.lexical` / `search.semantic` | `searchable` / `semantic` |
| Shapes | `record`, `document`, `scalar`, `blob`, `stream`, `unknown` | More detailed runtime/declaration kinds listed above |
| Coordination | `authorityFor` chooses `object` | Object is a boundary; authority remains database/storage/cache |
| Service calls | Key/value-oriented methods such as `read` and `upsert` | Full `StepContext` methods such as `get`, `upsert`, and `hydrate` |

The composition catalog is useful design vocabulary, but it is not a drop-in executable API or a migration shim. Avoid importing one file's types into the other's implementation based only on matching names.

## Development guidance

For compiler changes, follow the operation through `CloudMode → Plan → compose → validateCapabilities → Apply/Resume → run`. Keep composition provider-neutral, preserve the authority/projection distinction, and document changes in observable policy, ordering, or return behavior.

For a new provider, establish its exact capability/actions and guarantees, implement complete validation and codecs, then support the operation paths the application needs. Init support also requires persisted manifests, read-only inspection/diff, revision checks, and idempotent reconciliation. Object support must enter the identity boundary before stripping object routing; `clonePlanWithoutObject` is available for that internal continuation.

Meaningful verification targets include cache hit/miss branching with falsy values, source TTL preservation, explicit value dependencies, projection failures after commit, search hydration, contract retention on read/delete, rejected guarantee combinations, durable retry/deduplication, and concurrent/destructive Init changes.

### Verification

Run `npm run check` for the package source and `bun test` for the executable compiler and provider suites. Use the portable storage example for a runtime check of the shared HTTP routes, SQLite persistence and the Worker D1 binding. Published packages contain compiled JavaScript. For source examples, use a TypeScript runtime such as Bun that supports parameter properties.
