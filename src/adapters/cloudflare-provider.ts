/* ========================================================================== *
 * cloudflare-provider.ts
 *
 * Cloudflare realization of the generic Cloud capability contracts.
 *
 * Generic Cloud             Cloudflare
 * --------------------------------------------------
 * cache               ->    Workers KV
 * database            ->    D1
 * storage             ->    R2
 * index               ->    Vectorize
 * mind                ->    Workers AI
 * processor           ->    Worker / Service Binding
 * queue               ->    Queues
 * workflow            ->    Workflows
 * object              ->    Durable Objects
 * ========================================================================== */

import type {

  CacheService,
  CloudJob,
  CloudObjectHandle,
  CloudProvider,
  DatabaseService,
  IndexService,
  MindService,
  ObjectService,
  ProcessorService,
  QueueService,
  ServiceWriteOptions,
  StorageReadResult,
  StorageService,
  VectorEntry,
  VectorMatch,
  WorkflowInstance,
  WorkflowService

} from "../cloudC-model.js";

// ===========================================================================
// Minimal structural Cloudflare binding types
//
// In a deployed Worker, `wrangler types` can replace/augment these with the
// official generated runtime types.
// ===========================================================================


// KV ------------------------------------------------------------------------

interface KVBinding {

  get(
    key: string
  ): Promise<string | null>;

  put(
    key: string,
    value: string,
    options?: {
      expirationTtl?: number;
    }
  ): Promise<void>;

  delete(
    key: string
  ): Promise<void>;
}


// D1 ------------------------------------------------------------------------

interface D1Statement {

  bind(
    ...values: unknown[]
  ): D1Statement;

  first<T = unknown>():
    Promise<T | null>;

  run():
    Promise<unknown>;

  all<T = unknown>():
    Promise<{
      results?: T[];
    }>;
}


interface D1Binding {

  prepare(
    sql: string
  ): D1Statement;

  exec?(
    sql: string
  ): Promise<unknown>;
}


// R2 ------------------------------------------------------------------------

interface R2ObjectBodyLike {

  arrayBuffer():
    Promise<ArrayBuffer>;

  httpMetadata?: {
    contentType?: string;
  };

  customMetadata?: Record<string, string>;
}


interface R2Binding {

  get(
    key: string
  ): Promise<R2ObjectBodyLike | null>;

  put(
    key: string,
    value:
      | string
      | ArrayBuffer
      | ArrayBufferView
      | Blob,
    options?: {
      httpMetadata?: {
        contentType?: string;
      };

      customMetadata?: Record<string, string>;
    }
  ): Promise<unknown>;

  delete(
    key: string | string[]
  ): Promise<void>;

  list(
    options?: {
      prefix?: string;
      cursor?: string;
      limit?: number;
    }
  ): Promise<{
    objects: Array<{
      key: string;
    }>;

    cursor?: string;

    truncated?: boolean;
  }>;
}


// Vectorize -----------------------------------------------------------------

interface VectorizeBinding {

  upsert(
    vectors: Array<{
      id: string;

      values: number[];

      metadata?: Record<
        string,
        string | number | boolean
      >;
    }>
  ): Promise<unknown>;

  query(
    vector: number[],
    options?: {
      topK?: number;
      filter?: unknown;
      returnMetadata?: "none" | "indexed" | "all";
    }
  ): Promise<{
    matches: Array<{
      id: string;
      score: number;
      metadata?: Record<string, unknown>;
    }>;
  }>;

  deleteByIds(
    ids: string[]
  ): Promise<unknown>;
}


// Workers AI ----------------------------------------------------------------

interface WorkersAIBinding {

  run(
    model: string,
    input: unknown,
    options?: unknown
  ): Promise<unknown>;
}


// Queue ---------------------------------------------------------------------

interface QueueBinding<T = unknown> {

  send(
    body: T,
    options?: {
      delaySeconds?: number;
    }
  ): Promise<unknown>;
}


// Workflow ------------------------------------------------------------------

interface WorkflowBinding {

  create(
    options?: {
      id?: string;
      params?: unknown;
    }
  ): Promise<WorkflowInstanceBinding>;

  get(
    id: string
  ): Promise<WorkflowInstanceBinding>;
}


interface WorkflowInstanceBinding {

  id: string;

  status?:
    | string
    | (() => Promise<unknown>);

  terminate?():
    Promise<void>;
}


// Processor Worker ----------------------------------------------------------
//
// We deliberately standardize OUR worker entrypoint:
//
//   process(operation, input)
//
// The actual Cloudflare implementation can be an RPC Service Binding.

interface ProcessorBinding {

  process(
    operation: string,
    input: unknown,
    options?: Record<string, unknown>
  ): Promise<unknown>;
}


// Durable Object ------------------------------------------------------------
//
// Likewise, our Durable Object class conforms to OUR object protocol.

interface CloudDurableObjectStub {

  read():
    Promise<unknown>;

  write(
    value: unknown
  ): Promise<void>;

  delete():
    Promise<void>;

  process?(
    operation: string,
    input: unknown
  ): Promise<unknown>;
}


interface DurableObjectNamespaceBinding {

  getByName(
    name: string
  ): CloudDurableObjectStub;
}


// ===========================================================================
// Connector input
//
// Notice that these are GENERIC binding names.
//
// Whatever the Wrangler binding happens to be named can be supplied here.
// ===========================================================================

export interface CloudflareConnectorBindings {

  cache?: KVBinding;

  database?: D1Binding;

  storage?: R2Binding;

  index?: VectorizeBinding;

  mind?: WorkersAIBinding;

  processor?: ProcessorBinding;

  queue?: QueueBinding<CloudJob>;

  workflow?: WorkflowBinding;

  object?: DurableObjectNamespaceBinding;
}


export interface CloudflareProviderOptions {

  models?: {

    think?: string;

    embedding?: string;
  };
}


// ===========================================================================
// KV -> Cache
// ===========================================================================

class CloudflareCache
implements CacheService {

  constructor(
    private readonly kv: KVBinding
  ) {}


  async read<T>(
    key: string
  ): Promise<T | null> {

    const raw =
      await this.kv.get(key);

    if (raw === null)
      return null;

    const envelope =
      JSON.parse(raw);

    return envelope.value as T;
  }


  async upsert<T>(
    key: string,
    value: T,
    options: ServiceWriteOptions = {}
  ): Promise<void> {

    const ttlSeconds =
      options.ttlMs
        ? Math.max(
            1,
            Math.ceil(options.ttlMs / 1000)
          )
        : undefined;


    await this.kv.put(

      key,

      JSON.stringify({
        value,
        cachedAt:
          new Date().toISOString()
      }),

      ttlSeconds
        ? {
            expirationTtl:
              ttlSeconds
          }
        : undefined
    );
  }


  async delete(
    key: string
  ): Promise<void> {

    await this.kv.delete(key);
  }


  async stale(
    key: string
  ): Promise<void> {

    /*
     * Provider implementation detail:
     *
     * For the first implementation, invalidation == deletion.
     *
     * We can later replace this with version metadata or stale markers
     * without changing Cloud's generic semantics.
     */

    await this.kv.delete(key);
  }
}


// ===========================================================================
// D1 -> Database
// ===========================================================================

export const CLOUDFLARE_DATABASE_SCHEMA = `

CREATE TABLE IF NOT EXISTS cloud_objects (

  id TEXT PRIMARY KEY,

  type TEXT,

  version INTEGER NOT NULL DEFAULT 1,

  created_at TEXT NOT NULL,

  updated_at TEXT NOT NULL,

  expires_at TEXT,

  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS
  idx_cloud_objects_type
ON cloud_objects(type);

CREATE INDEX IF NOT EXISTS
  idx_cloud_objects_expires_at
ON cloud_objects(expires_at);

`;


class CloudflareDatabase
implements DatabaseService {

  constructor(
    private readonly db: D1Binding
  ) {}


  async read<T>(
    id: string
  ): Promise<T | null> {

    const row =
      await this.db
        .prepare(`
          SELECT
            data
          FROM cloud_objects
          WHERE id = ?
        `)
        .bind(id)
        .first<{ data: string }>();


    if (!row)
      return null;


    return JSON.parse(
      row.data
    ) as T;
  }


  async upsert<T>(
    id: string,
    value: T,
    options: ServiceWriteOptions = {}
  ): Promise<void> {

    const now =
      new Date().toISOString();


    const expiresAt =
      options.ttlMs
        ? new Date(
            Date.now() +
            options.ttlMs
          ).toISOString()
        : null;


    await this.db
      .prepare(`
        INSERT INTO cloud_objects (
          id,
          type,
          version,
          created_at,
          updated_at,
          expires_at,
          data
        )

        VALUES (?, ?, 1, ?, ?, ?, ?)

        ON CONFLICT(id)
        DO UPDATE SET

          version =
            cloud_objects.version + 1,

          updated_at =
            excluded.updated_at,

          expires_at =
            excluded.expires_at,

          data =
            excluded.data
      `)
      .bind(
        id,
        "object",
        now,
        now,
        expiresAt,
        JSON.stringify(value)
      )
      .run();
  }


  async delete(
    id: string
  ): Promise<void> {

    await this.db
      .prepare(`
        DELETE FROM cloud_objects
        WHERE id = ?
      `)
      .bind(id)
      .run();
  }


  async query<T>(
    sql: unknown,
    parameters: unknown[] = []
  ): Promise<T[]> {

    if (typeof sql !== "string")
      throw new TypeError(
        "D1 query requires SQL text."
      );


    const result =
      await this.db
        .prepare(sql)
        .bind(...parameters)
        .all<T>();


    return result.results ?? [];
  }
}


// ===========================================================================
// R2 -> Storage
// ===========================================================================

class CloudflareStorage
implements StorageService {

  constructor(
    private readonly bucket: R2Binding
  ) {}


  async read(
    key: string
  ): Promise<StorageReadResult | null> {

    const object =
      await this.bucket.get(key);


    if (!object)
      return null;


    return {

      value:
        await object.arrayBuffer(),

      contentType:
        object.httpMetadata
          ?.contentType,

      metadata:
        object.customMetadata
    };
  }


  async upsert(
    key: string,
    value: unknown,
    options: ServiceWriteOptions = {}
  ): Promise<void> {

    let body:
      | string
      | ArrayBuffer
      | ArrayBufferView
      | Blob;


    let contentType =
      options.contentType;


    if (
      typeof value === "string" ||
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value) ||
      value instanceof Blob
    ) {

      body = value as
        | string
        | ArrayBuffer
        | ArrayBufferView
        | Blob;

    } else {

      body =
        JSON.stringify(value);

      contentType ??=
        "application/json";
    }


    await this.bucket.put(
      key,
      body,

      {
        httpMetadata: {
          contentType
        },

        customMetadata:
          stringifyMetadata(
            options.metadata
          )
      }
    );
  }


  async delete(
    key: string
  ): Promise<void> {

    await this.bucket.delete(key);
  }


  async list(
    prefix = ""
  ): Promise<string[]> {

    const keys: string[] = [];

    let cursor:
      | string
      | undefined;


    do {

      const result =
        await this.bucket.list({
          prefix,
          cursor
        });


      keys.push(
        ...result.objects.map(
          object => object.key
        )
      );


      cursor =
        result.truncated
          ? result.cursor
          : undefined;

    } while (cursor);


    return keys;
  }
}


// ===========================================================================
// Vectorize -> Index
// ===========================================================================

class CloudflareIndex
implements IndexService {

  constructor(
    private readonly vectorize:
      VectorizeBinding
  ) {}


  async upsert(
    value:
      | VectorEntry
      | VectorEntry[]
  ): Promise<void> {

    const vectors =
      Array.isArray(value)
        ? value
        : [value];


    await this.vectorize.upsert(
      vectors
    );
  }


  async query(
    vector: number[],
    options: {
      topK?: number;
      filter?: unknown;
    } = {}
  ): Promise<VectorMatch[]> {

    const result =
      await this.vectorize.query(
        vector,

        {
          topK:
            options.topK ?? 5,

          filter:
            options.filter,

          returnMetadata:
            "all"
        }
      );


    return result.matches.map(
      match => ({

        id:
          match.id,

        score:
          match.score,

        metadata:
          match.metadata
      })
    );
  }


  async delete(
    ids: string | string[]
  ): Promise<void> {

    await this.vectorize
      .deleteByIds(
        Array.isArray(ids)
          ? ids
          : [ids]
      );
  }
}


// ===========================================================================
// Workers AI -> Mind
// ===========================================================================

class CloudflareMind
implements MindService {

  constructor(
    private readonly ai:
      WorkersAIBinding,

    private readonly models: {
      think: string;
      embedding: string;
    }
  ) {}


  async think<T>(
    task: string,
    input: unknown,
    options: Record<string, unknown> = {}
  ): Promise<T> {

    return await this.ai.run(

      this.models.think,

      {
        task,
        input,
        ...options
      }

    ) as T;
  }


  async embed(
    input: string | string[]
  ): Promise<number[][]> {

    const text =
      Array.isArray(input)
        ? input
        : [input];


    const result =
      await this.ai.run(

        this.models.embedding,

        {
          text
        }
      );


    /*
     * Workers AI embedding models generally expose vector data in
     * the returned object. Keep response decoding here because this
     * is precisely the kind of provider-specific detail Cloud itself
     * should never know.
     */

    const vectors =
      extractEmbeddingVectors(
        result
      );


    return vectors;
  }
}


// ===========================================================================
// Worker Service Binding -> Processor
// ===========================================================================

class CloudflareProcessor
implements ProcessorService {

  constructor(
    private readonly worker:
      ProcessorBinding
  ) {}


  async process<T>(
    operation: string,
    input: unknown,
    options: Record<string, unknown> = {}
  ): Promise<T> {

    return await this.worker
      .process(
        operation,
        input,
        options
      ) as T;
  }
}


// ===========================================================================
// Queues -> Queue
// ===========================================================================

class CloudflareQueue
implements QueueService {

  constructor(
    private readonly queue:
      QueueBinding<CloudJob>
  ) {}


  async enqueue(
    job: CloudJob,
    options: {
      delaySeconds?: number;
    } = {}
  ): Promise<void> {

    await this.queue.send(
      job,
      options
    );
  }
}


// ===========================================================================
// Workflows -> Workflow
// ===========================================================================

class CloudflareWorkflow
implements WorkflowService {

  constructor(
    private readonly workflow:
      WorkflowBinding
  ) {}


  async start(
    workflowName: string,
    input: unknown,
    options: {
      id?: string;
    } = {}
  ): Promise<WorkflowInstance> {

    /*
     * A particular Cloudflare binding already refers to a particular
     * Workflow class. `workflowName` remains in our generic contract,
     * but the connector owns the mapping.
     */

    const instance =
      await this.workflow.create({

        id:
          options.id,

        params: {
          workflow:
            workflowName,

          input
        }
      });


    return normalizeWorkflow(
      instance
    );
  }


  async status(
    id: string
  ): Promise<WorkflowInstance> {

    const instance =
      await this.workflow.get(id);


    return normalizeWorkflow(
      instance
    );
  }


  async cancel(
    id: string
  ): Promise<void> {

    const instance =
      await this.workflow.get(id);


    await instance.terminate?.();
  }
}


// ===========================================================================
// Durable Objects -> Object
// ===========================================================================

class CloudflareObjectHandle
implements CloudObjectHandle {

  constructor(
    private readonly stub:
      CloudDurableObjectStub
  ) {}


  async read<T>():
    Promise<T | null> {

    return (await this.stub.read()) as T | null;
  }


  async write<T>(
    value: T
  ): Promise<void> {

    await this.stub.write(
      value
    );
  }


  async delete():
    Promise<void> {

    await this.stub.delete();
  }


  async process<T>(
    operation: string,
    input: unknown
  ): Promise<T> {

    if (!this.stub.process)
      throw new Error(
        "Durable Object does not expose process()."
      );


    return await this.stub.process(
      operation,
      input
    ) as T;
  }
}


class CloudflareObjectService
implements ObjectService {

  constructor(
    private readonly namespace:
      DurableObjectNamespaceBinding
  ) {}


  get(
    id: string
  ): CloudObjectHandle {

    return new CloudflareObjectHandle(
      this.namespace.getByName(id)
    );
  }
}


// ===========================================================================
// Provider factory
// ===========================================================================

export function createCloudflareProvider(

  bindings:
    CloudflareConnectorBindings,

  options:
    CloudflareProviderOptions = {}

): CloudProvider {


  const services = {

    cache:
      bindings.cache
        ? new CloudflareCache(
            bindings.cache
          )
        : undefined,


    database:
      bindings.database
        ? new CloudflareDatabase(
            bindings.database
          )
        : undefined,


    storage:
      bindings.storage
        ? new CloudflareStorage(
            bindings.storage
          )
        : undefined,


    index:
      bindings.index
        ? new CloudflareIndex(
            bindings.index
          )
        : undefined,


    mind:
      bindings.mind
        ? new CloudflareMind(

            bindings.mind,

            {
              think:
                options.models?.think ??
                "@cf/meta/llama-3.1-8b-instruct",

              embedding:
                options.models?.embedding ??
                "@cf/baai/bge-m3"
            }
          )
        : undefined,


    processor:
      bindings.processor
        ? new CloudflareProcessor(
            bindings.processor
          )
        : undefined,


    queue:
      bindings.queue
        ? new CloudflareQueue(
            bindings.queue
          )
        : undefined,


    workflow:
      bindings.workflow
        ? new CloudflareWorkflow(
            bindings.workflow
          )
        : undefined,


    object:
      bindings.object
        ? new CloudflareObjectService(
            bindings.object
          )
        : undefined

  };


  return {

    id:
      "cloudflare",

    services,


    capabilities: {

      cache: {
        available:
          !!services.cache,

        implementation:
          "Cloudflare Workers KV",

        features: [
          "global-read",
          "ttl",
          "eventual-projection"
        ]
      },


      database: {
        available:
          !!services.database,

        implementation:
          "Cloudflare D1",

        features: [
          "sql",
          "structured",
          "transactions",
          "json-authority"
        ]
      },


      storage: {
        available:
          !!services.storage,

        implementation:
          "Cloudflare R2",

        features: [
          "objects",
          "blobs",
          "streaming",
          "strong-object-consistency"
        ]
      },


      index: {
        available:
          !!services.index,

        implementation:
          "Cloudflare Vectorize",

        features: [
          "vector",
          "similarity",
          "metadata-filtering"
        ]
      },


      mind: {
        available:
          !!services.mind,

        implementation:
          "Cloudflare Workers AI",

        features: [
          "inference",
          "embeddings"
        ]
      },


      processor: {
        available:
          !!services.processor,

        implementation:
          "Cloudflare Worker Service Binding",

        features: [
          "compute",
          "rpc"
        ]
      },


      queue: {
        available:
          !!services.queue,

        implementation:
          "Cloudflare Queues",

        features: [
          "durable-async",
          "delayed-delivery"
        ]
      },


      workflow: {
        available:
          !!services.workflow,

        implementation:
          "Cloudflare Workflows",

        features: [
          "durable-orchestration",
          "waiting",
          "multi-stage"
        ]
      },


      object: {
        available:
          !!services.object,

        implementation:
          "Cloudflare Durable Objects",

        features: [
          "identity",
          "coordination",
          "rpc",
          "stateful-authority"
        ]
      }
    }
  };
}


// ===========================================================================
// Provider-private helpers
// ===========================================================================

function stringifyMetadata(
  metadata?: Record<string, unknown>
): Record<string, string> | undefined {

  if (!metadata)
    return undefined;


  return Object.fromEntries(

    Object.entries(metadata).map(
      ([key, value]) => [
        key,
        String(value)
      ]
    )
  );
}


function extractEmbeddingVectors(
  result: unknown
): number[][] {

  const candidate =
    result as {
      data?: unknown;
    };


  const data =
    candidate?.data;


  if (
    Array.isArray(data) &&
    Array.isArray(data[0])
  ) {

    return data as number[][];
  }


  if (
    Array.isArray(data) &&
    typeof data[0] === "number"
  ) {

    return [
      data as number[]
    ];
  }


  throw new Error(
    "Unable to decode Workers AI embedding result."
  );
}


async function normalizeWorkflow(
  instance: WorkflowInstanceBinding
): Promise<WorkflowInstance> {

  let status = "unknown";


  if (
    typeof instance.status ===
    "function"
  ) {

    const result =
      await instance.status();


    if (
      result &&
      typeof result === "object" &&
      "status" in result
    ) {

      status =
        String(
          (
            result as {
              status: unknown
            }
          ).status
        );
    }

  } else if (
    typeof instance.status ===
    "string"
  ) {

    status =
      instance.status;
  }


  return {

    id:
      instance.id,

    status
  };
}
