import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import test from "node:test";

import Cloud, { CloudRef, decodeValue, type StepContext } from "../cloudC.js";
import {
  CloudflareProvider, createCloudflareProvider, createCloudflareObjectRunner,
  resumeCloudflareWorkflow, CLOUDFLARE_D1_SCHEMA,
  CloudflareAdapter,
  consumeCloudflareQueue,
  runCloudflareObject,
  type CloudflareQueueMessage,
  type CloudflareQueuedJob,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type KVNamespaceLike,
  type R2BucketLike,
  type R2ObjectBodyLike,
  type VectorizeIndexLike,
} from "./cloudflare.js";

class TestStatement implements D1PreparedStatementLike {
  constructor(private readonly statement: StatementSync, private readonly bindings: unknown[] = []) {}
  bind(...values: unknown[]): D1PreparedStatementLike { return new TestStatement(this.statement, values); }
  async first<Row = Record<string, unknown>>(column?: string): Promise<Row | null> {
    const row = this.statement.get(...this.bindings as SQLInputValue[]) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as Row;
  }
  async all<Row = Record<string, unknown>>() {
    return { success: true, results: this.statement.all(...this.bindings as SQLInputValue[]) as Row[] };
  }
  async run<Row = Record<string, unknown>>() {
    const result = this.statement.run(...this.bindings as SQLInputValue[]);
    return { success: true, results: [] as Row[], meta: { changes: Number(result.changes) } };
  }
}

class TestD1 implements D1DatabaseLike {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string): D1PreparedStatementLike { return new TestStatement(this.sqlite.prepare(sql)); }
  async exec(sql: string): Promise<void> { this.sqlite.exec(sql); }
}

class TestKV implements KVNamespaceLike {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number | undefined>();
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async put(key: string, value: string | ArrayBuffer, options?: { expirationTtl?: number }): Promise<void> {
    this.values.set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
    this.ttls.set(key, options?.expirationTtl);
  }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}

class LaggingDeleteKV extends TestKV {
  override async delete(_key: string): Promise<void> { /* simulate KV propagation lag */ }
}

class TestR2 implements R2BucketLike {
  readonly values = new Map<string, { bytes: ArrayBuffer; customMetadata?: Record<string, string> }>();
  async head(key: string) { return this.values.get(key) ?? null; }
  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const entry = this.values.get(key);
    return entry ? { ...entry, arrayBuffer: async () => entry.bytes.slice(0) } : null;
  }
  async put(key: string, value: ArrayBuffer | ArrayBufferView | Blob, options?: { customMetadata?: Record<string, string> }) {
    const bytes = value instanceof Blob
      ? await value.arrayBuffer()
      : value instanceof ArrayBuffer
        ? value.slice(0)
        : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
    const entry = { bytes, customMetadata: options?.customMetadata };
    this.values.set(key, entry);
    return entry;
  }
  async delete(key: string | string[]): Promise<void> {
    for (const item of Array.isArray(key) ? key : [key]) this.values.delete(item);
  }
}

class TestVectorize implements VectorizeIndexLike {
  readonly vectors = new Map<string, { values: number[]; namespace?: string; metadata?: Record<string, string | number | boolean> }>();
  async upsert(vectors: readonly { id: string; values: number[] | Float32Array | Float64Array; namespace?: string; metadata?: Record<string, string | number | boolean> }[]) {
    for (const vector of vectors) this.vectors.set(vector.id, { ...vector, values: [...vector.values] });
    return {};
  }
  async query(_vector: number[] | Float32Array | Float64Array, options: { topK: number; namespace?: string; returnMetadata: "all" }) {
    return { matches: [...this.vectors.entries()]
      .filter(([, vector]) => vector.namespace === options.namespace)
      .slice(0, options.topK)
      .map(([id, vector]) => ({ id, score: 0.9, metadata: vector.metadata })) };
  }
  async deleteByIds(ids: string[]) { for (const id of ids) this.vectors.delete(id); return {}; }
}

function ids() {
  let next = 0;
  return () => `plan-${++next}`;
}

test("D1 + KV implements Init, document CRUD and field search", async () => {
  const database = new TestD1();
  const cache = new LaggingDeleteKV();
  const adapter = new CloudflareAdapter({ database, cache });
  const cloud = new Cloud({ adapter, id: ids() });

  const init = await cloud.Init.Write("customer", {
    shape: { id: { type: "string", key: true }, email: "string", active: "boolean" },
    persistent: true,
    fast: true,
    searchable: ["email", "active"],
  });
  assert.deepEqual(new Set(init.required), new Set(["database", "cache", "index"]));
  await cloud.Apply(init);

  const value = { id: "123", email: "ada@example.com", active: true };
  await cloud.Write("customer:123", value, { fresh: true });
  assert.deepEqual(await cloud.Read("customer:123"), value);
  assert.deepEqual(await cloud.Read("customer", { query: { text: "ada", where: { active: true } } }), [value]);

  await cloud.Delete("customer:123");
  // The old KV value still exists, but its version no longer has authority.
  assert.equal(await cloud.Read("customer:123"), undefined);

  await assert.rejects(
    cloud.Init.Write("customer", { shape: { id: "string" }, persistent: true }),
    /does not perform in-place subject migrations/,
  );
  const removal = await cloud.Init.Delete("customer");
  assert.ok(removal.changes?.some(change => change.destructive));
  await cloud.Apply(removal);
  assert.equal((await cloud.Init.Read("customer")).state, null);
});

test("R2 is used as the authoritative store for blobs", async () => {
  const database = new TestD1();
  const storage = new TestR2();
  const adapter = new CloudflareAdapter({ database, storage });
  const cloud = new Cloud({ adapter, id: ids() });
  const init = await cloud.Init.Write("media", { shape: "blob", persistent: true });
  await cloud.Apply(init);

  await cloud.Write("media:logo", new Uint8Array([1, 2, 3]));
  const result = await cloud.Read("media:logo") as ArrayBuffer;
  assert.deepEqual([...new Uint8Array(result)], [1, 2, 3]);
});

test("Workers AI embeddings and Vectorize implement semantic reads", async () => {
  const database = new TestD1();
  const vectorize = new TestVectorize();
  const ai = { async run(_model: string, input: unknown) {
    assert.ok(Array.isArray((input as { text: unknown[] }).text));
    return { data: [[0.1, 0.2, 0.3]] };
  } };
  const adapter = new CloudflareAdapter({ database, vectorize, ai });
  const cloud = new Cloud({ adapter, id: ids() });
  await cloud.Apply(await cloud.Init.Write("note", {
    shape: { id: "string", body: "string" },
    persistent: true,
    semantic: ["body"],
  }));

  const note = { id: "n1", body: "orange clouds" };
  await cloud.Write("note:n1", note);
  assert.deepEqual(await cloud.Read("note", { similar: "citrus sky" }), [note]);
});

test("Queue consumer durably deduplicates retries", async () => {
  const database = new TestD1();
  const sent: CloudflareQueuedJob[] = [];
  let runs = 0;
  const queue = { async send(job: CloudflareQueuedJob) { sent.push(job); return {}; } };
  const adapter = new CloudflareAdapter({
    database,
    queue,
    processors: { resize: async input => {
      const value = input as { image: CloudRef; requestedAt: Date; pixels: bigint };
      assert.ok(value.image instanceof CloudRef);
      assert.ok(value.requestedAt instanceof Date);
      assert.equal(value.pixels, 42n);
      runs++;
      return input;
    } },
  });
  const cloud = new Cloud({ adapter, id: ids() });
  const receipt = await cloud.Process("resize", {
    image: new CloudRef("media:1"),
    requestedAt: new Date("2026-10-09T12:00:00Z"),
    pixels: 42n,
  }, { async: true, idempotencyKey: "resize-1" }) as { jobID: string };
  assert.equal(receipt.jobID, sent[0].jobID);

  let acknowledgements = 0;
  const message: CloudflareQueueMessage = {
    body: sent[0],
    ack: () => { acknowledgements++; },
    retry: () => assert.fail("successful work must not retry"),
  };
  await consumeCloudflareQueue(cloud, adapter, { messages: [message] });
  await consumeCloudflareQueue(cloud, adapter, { messages: [message] });
  assert.equal(runs, 1);
  assert.equal(acknowledgements, 2);
});

test("Durable Object RPC executes the plan after entering its identity boundary", async () => {
  const database = new TestD1();
  let cloud!: Cloud;
  const objects = { getByName(name: string) {
    assert.equal(name, "counter:one");
    return { run: (plan: Parameters<typeof runCloudflareObject>[1]) => runCloudflareObject(cloud, plan) };
  } };
  const adapter = new CloudflareAdapter({ database, objects });
  cloud = new Cloud({ adapter, id: ids() });

  const counter = cloud.Object("counter:one");
  await counter.Write({ value: 1 });
  assert.deepEqual(await counter.Read(), { value: 1 });
});

test("provider and adapter options share one implementation and migration schema", async () => {
  assert.equal(CloudflareAdapter, CloudflareProvider);
  const database = new TestD1();
  await database.exec(readFileSync(new URL("./cloudflare.sql", import.meta.url), "utf8"));
  await database.exec(CLOUDFLARE_D1_SCHEMA); // Idempotent against the actual migration.
  const provider = createCloudflareProvider({ database, cache: new TestKV() }, { autoMigrate: false });
  const legacy = new Cloud({ adapter: provider });
  const composed = new Cloud({ provider });
  const contract = { shape: { title: "string" as const }, persistent: true, fast: true, searchable: ["title"] };
  await composed.Apply(await composed.Init.Write("article", contract));
  await legacy.Write("article:1", { title: "shared" }, { fresh: true });
  assert.deepEqual(await composed.Read("article:1"), { title: "shared" });
  await composed.Write("article:2", { title: "also shared" });
  assert.deepEqual(await legacy.Read("article", { query: "also" }), [{ title: "also shared" }]);
  await assert.rejects(composed.Write("article:bad", { title: 42 }), /must match string/);
  await legacy.Delete("article:1");
  assert.equal(await composed.Read("article:1"), undefined);
});

test("cache fills preserve the source version across an interleaved newer write", async () => {
  const database = new TestD1();
  const cache = new TestKV();
  const provider = createCloudflareProvider({ database, cache });
  const cloud = new Cloud({ provider, id: ids(), defaults: { persistent: true, fast: true } });
  await cloud.Write("race:1", { value: "old" });
  const get = provider.services.database!.get;
  let interleave = true;
  provider.services.database!.get = async context => {
    const source = await get(context);
    if (interleave) {
      interleave = false;
      await cloud.Write("race:1", { value: "new" }, { fresh: true });
    }
    return source;
  };
  assert.deepEqual(await cloud.Read("race:1"), { value: "old" });
  const cached = JSON.parse(cache.values.get("cloud:race:1")!) as { version: string; payload: string };
  assert.equal(cached.version, "plan-1");
  assert.deepEqual(decodeValue(cached.payload), { value: "old" });
  // An older in-flight read may finish late, but cannot relabel its data as new.
  assert.deepEqual(await cloud.Read("race:1"), { value: "new" });
});

test("cache hit discriminants preserve null, undefined and other falsy values", async () => {
  const provider = createCloudflareProvider({ database: new TestD1(), cache: new TestKV() });
  const cloud = new Cloud({ provider, defaults: { persistent: true, fast: true } });
  let authorityReads = 0;
  const get = provider.services.database!.get;
  provider.services.database!.get = async context => { authorityReads++; return get(context); };
  for (const [index, value] of [undefined, null, false, 0, ""].entries()) {
    await cloud.Write(`falsy:${index}`, value, { fresh: true });
    assert.equal(await cloud.Read(`falsy:${index}`), value);
  }
  assert.equal(authorityReads, 0);
});

test("D1 and KV share the portable tagged value codec", async () => {
  const provider = createCloudflareProvider({ database: new TestD1(), cache: new TestKV() });
  const cloud = new Cloud({ provider, defaults: { persistent: true, fast: true } });
  const value = { date: new Date("2026-10-09T00:00:00Z"), count: 42n, absent: undefined,
    ref: new CloudRef("media:1"), bytes: new Uint8Array([1, 2]).buffer };
  await cloud.Write("codec:1", value);
  assert.deepEqual(await cloud.Read("codec:1"), value); // D1 miss path fills KV.
  assert.deepEqual(await cloud.Read("codec:1"), value); // KV hit path.
});

test("cache refresh never extends a record's original lifetime", async () => {
  let now = 1000;
  const database = new TestD1();
  const cache = new TestKV();
  const provider = createCloudflareProvider({ database, cache }, { now: () => now });
  const cloud = new Cloud({ provider, defaults: { persistent: true, fast: true } });
  await cloud.Apply(await cloud.Init.Write("ttl", { shape: { value: "string" }, persistent: true, fast: true, ttl: 120 }));
  await cloud.Write("ttl:1", { value: "expires" });
  now = 1100;
  assert.deepEqual(await cloud.Read("ttl:1"), { value: "expires" });
  assert.equal(JSON.parse(cache.values.get("cloud:ttl:1")!).expiresAt, 1120);
  assert.equal(cache.ttls.get("cloud:ttl:1"), 60); // KV minimum; logical expiry is 20s.
  now = 1121;
  assert.equal(await cloud.Read("ttl:1"), undefined);
  await cloud.Write("ephemeral:1", null, { persistent: false, ttl: 60 });
  now += 61;
  assert.equal(await cloud.Read("ephemeral:1", { persistent: false, ttl: 60 }), undefined);
  await assert.rejects(cloud.Write("ttl:short", null, { shape: "null", ttl: 30 }), /TTL must be at least 60/);
});

test("factory maps semantic bindings and deferred writes retain their complete continuation", async () => {
  const sent: CloudflareQueuedJob[] = [];
  const vectors = new TestVectorize();
  const provider = createCloudflareProvider({
    database: new TestD1(), cache: new TestKV(), index: vectors,
    mind: { run: async () => ({ data: [[0.1, 0.2]] }) },
    queue: { send: async job => { sent.push(job); } },
  });
  const cloud = new Cloud({ provider });
  await cloud.Apply(await cloud.Init.Write("deferred", { shape: { title: "string" },
    persistent: true, fast: true, semantic: ["title"], async: true }));
  await cloud.Write("deferred:1", { title: "later" }, { async: true });
  assert.equal(await cloud.Read("deferred:1"), undefined);
  await consumeCloudflareQueue(cloud, provider, { messages: [{ body: sent[0], ack() {}, retry() { assert.fail("unexpected retry"); } }] });
  assert.deepEqual(await cloud.Read("deferred", { similar: "future" }), [{ title: "later" }]);
  assert.equal(vectors.vectors.size, 1);
});

test("workflow and processor service ports resume rather than redispatch work", async () => {
  const jobs: CloudflareQueuedJob[] = [];
  let runs = 0;
  const provider = createCloudflareProvider({ database: new TestD1(),
    processor: { process: async (ref, input) => { assert.equal(ref, "resize"); runs++; return input; } },
    workflow: { create: async ({ id, params }) => { jobs.push(params); return { id }; } },
  });
  const cloud = new Cloud({ provider });
  const receipt = await cloud.Process("resize", { pixels: 42n }, { workflow: true }) as { jobID: string };
  assert.equal(receipt.jobID, jobs[0].jobID);
  assert.equal(runs, 0);
  assert.deepEqual(await resumeCloudflareWorkflow(cloud, jobs[0]), { pixels: 42n });
  assert.equal(runs, 1);
  assert.equal(jobs.length, 1);
});

test("per-instance object runner serializes across external awaits and recovers after rejection", async () => {
  const provider = createCloudflareProvider({ database: new TestD1(),
    object: { getByName: () => ({ run: plan => runner(plan) }) },
  });
  const cloud = new Cloud({ provider });
  const runner = createCloudflareObjectRunner(cloud);
  const upsert = provider.services.database!.upsert;
  let release!: () => void;
  let entered!: () => void;
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  const pause = new Promise<void>(resolve => { release = resolve; });
  const order: number[] = [];
  provider.services.database!.upsert = async (context: StepContext) => {
    const value = (context.input as { value: number }).value;
    order.push(value);
    if (value === 1) { entered(); await pause; throw new Error("first failed"); }
    return upsert(context);
  };
  const first = cloud.Object("serial:1").Write({ value: 1 });
  const rejected = assert.rejects(first, /first failed/);
  await firstEntered;
  const second = cloud.Object("serial:1").Write({ value: 2 });
  await Promise.resolve();
  assert.deepEqual(order, [1]);
  release();
  await rejected;
  await second;
  assert.deepEqual(order, [1, 2]);
  assert.deepEqual(await cloud.Object("serial:1").Read(), { value: 2 });
});
