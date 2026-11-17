# Cloudflare adapter

`cloudflare.ts` maps the provider-neutral `CloudC` plan to Cloudflare Workers bindings:

| Cloud capability | Cloudflare implementation |
| --- | --- |
| `database` | D1 document envelopes |
| `storage` | R2 objects for top-level blobs |
| `cache` | Workers KV |
| `index` | D1 search projections; Vectorize for semantic search |
| `mind` | Workers AI |
| `processor` | A registry of portable application functions |
| `queue` | Cloudflare Queues with D1 idempotency leases |
| `workflow` | Cloudflare Workflows |
| `object` | Durable Objects RPC |

The adapter never derives a table from a runtime object. All non-blob records use one encoded envelope, and `Init` stores a separate subject manifest. By default, `customer:123` inherits the manifest for `customer`; override `subjectFromRef` if the application uses another identity scheme.

## Bindings

Create only the bindings the application needs. A representative `wrangler.jsonc` section is:

```jsonc
{
  "d1_databases": [
    { "binding": "CLOUD_DB", "database_name": "cloud", "database_id": "..." }
  ],
  "kv_namespaces": [
    { "binding": "CLOUD_CACHE", "id": "..." }
  ],
  "r2_buckets": [
    { "binding": "CLOUD_STORAGE", "bucket_name": "cloud" }
  ],
  "vectorize": [
    { "binding": "CLOUD_VECTORS", "index_name": "cloud-vectors" }
  ],
  "ai": { "binding": "AI" },
  "queues": {
    "producers": [{ "binding": "CLOUD_QUEUE", "queue": "cloud-jobs" }],
    "consumers": [{ "queue": "cloud-jobs" }]
  },
  "workflows": [
    { "binding": "CLOUD_WORKFLOW", "name": "cloud-workflow", "class_name": "CloudWorkflow" }
  ],
  "durable_objects": {
    "bindings": [{ "name": "CLOUD_OBJECTS", "class_name": "CloudObject" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["CloudObject"] }
  ]
}
```

Create Vectorize with dimensions matching the configured embedding model. The default model is `@cf/baai/bge-base-en-v1.5`, which emits 768 dimensions.

Apply [0001_cloudflare.sql](./0001_cloudflare.sql) as a D1 migration and set `autoMigrate: false` in production. The default `autoMigrate: true` is convenient for local development and an executable reference, but production schema rollout should be explicit.

## Constructing Cloud

```ts
import CloudC from "./Cloud/cloudC.ts";
import CloudflareAdapter from "./Cloud/cloudflare.ts";

function makeCloud(env: Env) {
  const adapter = new CloudflareAdapter({
    database: env.CLOUD_DB,
    cache: env.CLOUD_CACHE,
    storage: env.CLOUD_STORAGE,
    vectorize: env.CLOUD_VECTORS,
    ai: env.AI,
    queue: env.CLOUD_QUEUE,
    workflow: env.CLOUD_WORKFLOW,
    objects: env.CLOUD_OBJECTS,
    autoMigrate: false,
    models: {
      think: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      embedding: "@cf/baai/bge-base-en-v1.5"
    },
    processors: {
      resizeImage: async input => resizeImage(input)
    }
  });
  return { adapter, cloud: new CloudC({ adapter }) };
}
```

Establish and review a subject contract before applying it. Do this from a controlled deployment/admin path, not a public request handler:

```ts
const { cloud } = makeCloud(env);
const plan = await cloud.Init.Write("customer", {
  shape: {
    id: { type: "string", key: true },
    email: "string",
    bio: "string"
  },
  persistent: true,
  fast: true,
  searchable: ["email"],
  semantic: ["bio"]
});

// Present plan.changes for review before this explicit mutation.
await cloud.Apply(plan);
```

Runtime use then remains provider-independent:

```ts
await cloud.Write("customer:123", {
  id: "123",
  email: "m@example.com",
  bio: "Distributed systems researcher"
}, { fresh: true });

const exact = await cloud.Read("customer:123");
const matches = await cloud.Read("customer", {
  query: { text: "example.com", where: { email: "m@example.com" }, limit: 10 }
});
const similar = await cloud.Read("customer", { similar: "database researcher" });
```

Keyword query objects accept only `text`, scalar `where` equality, and `limit` from 1 through 100. A `where` field must be declared searchable. Semantic search uses the Init subject as a Vectorize namespace and returns hydrated authoritative records rather than vector metadata.

## Queue consumer

The producer returns only after `Queue.send()` durably accepts the envelope. The consumer uses D1 leases and the envelope's idempotency key to prevent duplicate processor execution:

```ts
import { consumeCloudflareQueue, type CloudflareQueuedJob } from "./Cloud/cloudflare.ts";

export default {
  async queue(batch: MessageBatch<CloudflareQueuedJob>, env: Env) {
    const { adapter, cloud } = makeCloud(env);
    await consumeCloudflareQueue(cloud, adapter, batch);
  }
};
```

## Workflow and Durable Object entry points

Call `resumeCloudflareWorkflow(cloud, event.payload)` from a Workflow step. Cloudflare owns the workflow checkpoints and retries; the helper resumes the enclosed runtime plan without dispatching it again.

Expose `run` as an RPC method on the configured Durable Object class:

```ts
import { DurableObject } from "cloudflare:workers";
import type { CloudPlan } from "./Cloud/cloud.ts";
import { runCloudflareObject } from "./Cloud/cloudflare.ts";

export class CloudObject extends DurableObject<Env> {
  async run(plan: CloudPlan) {
    const { cloud } = makeCloud(this.env);
    return runCloudflareObject(cloud, plan);
  }
}
```

`runCloudflareObject` removes the object route only after the call has entered that identity's Durable Object, preventing recursive dispatch while preserving serialized execution.

## Guarantees and limits

- D1 and R2 are authoritative. KV is explicitly a stale-capable cache and is bypassed by fresh reads.
- KV TTLs below 60 seconds are rejected because Workers KV does not support them.
- `realtime` is rejected when a plan crosses KV or index maintenance; the adapter does not claim a cross-service transaction.
- In-place subject migrations are rejected. Migrate existing data deliberately, or review and apply `Init.Delete` before establishing the replacement contract.
- D1 record versions and tombstones gate index-maintenance requests, and search hits are always hydrated from the authoritative store so a stale index ID cannot resurrect deleted data.
- Vectorize mutations are asynchronous. A just-written vector may take a short time to become queryable.
- Values are encoded with tags so `Date`, `bigint`, `undefined`, binary values, and `CloudRef` survive D1/KV round trips. Top-level blobs remain raw in R2.
- Queue job IDs and Workflow instance IDs are deterministic hashes of `idempotencyKey`.
