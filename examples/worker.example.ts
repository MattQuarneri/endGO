import CloudC from "../src/cloudC.js";
import {
  createCloudflareProvider,
  consumeCloudflareQueue,
  type CloudflareConnectorBindings,
  type CloudflareQueueBatch,
} from "../src/adapters/cloudflare.js";

/** Structural types; actual Workers projects can use wrangler types. */
export interface Env {
  DATABASE: CloudflareConnectorBindings["database"];
  CACHE?: CloudflareConnectorBindings["cache"];
  STORAGE?: CloudflareConnectorBindings["storage"];
  INDEX?: CloudflareConnectorBindings["index"];
  MIND?: CloudflareConnectorBindings["mind"];
  PROCESSOR?: CloudflareConnectorBindings["processor"];
  QUEUE?: CloudflareConnectorBindings["queue"];
  WORKFLOW?: CloudflareConnectorBindings["workflow"];
  OBJECT?: CloudflareConnectorBindings["object"];
}

export function makeCloud(env: Env) {
  const provider = createCloudflareProvider({
    database: env.DATABASE,
    cache: env.CACHE,
    storage: env.STORAGE,
    index: env.INDEX,
    mind: env.MIND,
    processor: env.PROCESSOR,
    queue: env.QUEUE,
    workflow: env.WORKFLOW,
    object: env.OBJECT,
  }, { autoMigrate: false }); // Apply src/adapters/cloudflare.sql before deployment.
  return { provider, cloud: new CloudC({ provider }) };
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const { cloud } = makeCloud(env);
    // Use cloud.Read/Write/etc. in authenticated application handlers.
    // Review and Apply cloud.Init plans only from an admin/deployment path.
    void cloud;
    return new Response("Cloud ready.");
  },
  async queue(batch: CloudflareQueueBatch, env: Env): Promise<void> {
    const { cloud, provider } = makeCloud(env);
    await consumeCloudflareQueue(cloud, provider, batch);
  },
};

/** Composition is provider-neutral:
Cloud.Write(
  "article:123",
  article,
  {
    persistent: true,
    fast: true,
    semantic: ["title", "body"]
  }
);

Becomes:

Requirements
────────────────────────
durability     persistent
speed          fast
consistency    eventual
semantic       title, body
execution      now

Then:

Composition
────────────────────────
database
cache
mind
index

and only after crossing the provider boundary does that become:

Cloudflare
────────────────────────
database    → D1
cache       → KV
mind        → Workers AI
index       → Vectorize

or:

AWS
────────────────────────
database    → Aurora/Postgres
cache       → ElastiCache
mind        → Bedrock
index       → OpenSearch

or:

GCP
────────────────────────
database    → Cloud SQL
cache       → Memorystore
mind        → Vertex AI
index       → Vertex Search


or even:

Local
────────────────────────
database    → SQLite
cache       → Valkey
mind        → Ollama
index       → pgvector / Qdrant

Core Architecture: Composition belongs to Cloud. Conducting belongs to the provider.
persistent + fast + semantic -> database + cache + mind + index.
database + cache + mind + index is part of the Cloud statement. D1 + KV + Workers AI + Vectorize is merely one provider's implementation of that sentence.
Only the provider maps that to D1 + KV + Workers AI + Vectorize.
*/
