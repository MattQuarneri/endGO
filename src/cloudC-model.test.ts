import assert from "node:assert/strict";
import test from "node:test";
import Cloud, {
  CloudProvider, authorityFor, compose, normalizeRequirements, normalizeShape,
  validateCapabilities, type AuthorityResult, type CapabilityCatalog,
  type CloudProviderServices,
} from "./cloudC.js";

const record = normalizeShape({ title: "string", body: "string" });
function plan(operation: "write" | "read" | "delete", requirements = normalizeRequirements(),
  policy = {}, mode: "runtime" | "init" = "runtime") {
  return compose({ ref: "article:1", mode, operation, shape: record, requirements,
    value: { title: "hello", body: "cloud" }, policy }, () => "plan-1");
}
function actions(value: ReturnType<typeof plan>) {
  return value.steps.map(step => `${step.capability}.${step.action}`);
}

test("composer keeps cache miss authority and explicit value dependencies", () => {
  const read = plan("read", normalizeRequirements({ fast: true }));
  assert.deepEqual(actions(read), ["cache.get", "database.get", "cache.put"]);
  assert.deepEqual(read.required, ["cache", "database"]);
  assert.equal(read.steps[1].onMissOf, read.steps[0].id);
  assert.equal(read.steps[2].onMissOf, read.steps[0].id);
  assert.equal(read.steps[2].inputFrom, read.steps[1].id);
  assert.deepEqual(actions(plan("read", normalizeRequirements({ fast: true, fresh: true }))),
    ["database.get", "cache.put"]);
  assert.deepEqual(actions(plan("write", normalizeRequirements({ fast: true }))),
    ["database.upsert", "cache.invalidate"]);
  assert.deepEqual(actions(plan("write", normalizeRequirements({ fast: true, fresh: true }))),
    ["database.upsert", "cache.put"]);
});

test("composer includes deferred continuations and semantic hydration", () => {
  const requirements = normalizeRequirements({ fast: true, semantic: ["body"], later: true });
  const write = plan("write", requirements);
  assert.equal(write.route, "queue");
  assert.deepEqual(new Set(write.required), new Set(["database", "cache", "mind", "index", "queue"]));
  assert.deepEqual(actions(write), ["database.upsert", "cache.invalidate", "mind.embed", "index.upsertVector"]);
  assert.equal(write.steps[3].inputFrom, write.steps[2].id);
  assert.deepEqual(actions(plan("read", requirements, { similar: "sky" })),
    ["mind.embedQuery", "index.searchVector", "database.hydrate"]);
  assert.deepEqual(actions(plan("read", normalizeRequirements({ searchable: ["title"] }), { query: "hello" })),
    ["index.search", "database.hydrate"]);
  assert.deepEqual(actions(plan("delete", requirements)), ["database.delete", "cache.invalidate", "index.delete"]);
  const workflow = plan("write", normalizeRequirements({ workflow: true }));
  assert.equal(workflow.route, "workflow");
  assert.deepEqual(workflow.required, ["database", "workflow"]);
  assert.deepEqual(actions(workflow), ["database.upsert"]);
});

test("coordination adds an execution boundary without relocating authority", () => {
  const requirements = normalizeRequirements({ coordinated: true });
  assert.equal(authorityFor(record, requirements), "database");
  assert.equal(authorityFor({ kind: "blob" }, requirements), "storage");
  const write = plan("write", requirements);
  assert.equal(write.route, "object");
  assert.equal(write.ir.objectID, "article:1");
  assert.deepEqual(write.required, ["database", "object"]);
  assert.deepEqual(actions(write), ["database.upsert"]);
});

test("Init describes all potential capabilities, while read/delete inspect existing state", () => {
  const requirements = normalizeRequirements({ fast: true, semantic: ["body"], later: true });
  const init = plan("write", requirements, {}, "init");
  assert.deepEqual(new Set(init.required), new Set(["database", "cache", "index", "mind", "queue"]));
  assert.deepEqual(init.steps, []);
  for (const operation of ["read", "delete"] as const) {
    const observed = plan(operation, normalizeRequirements(), {}, "init");
    assert.deepEqual(observed.required, []);
    assert.equal(observed.route, "inline");
  }
  assert.throws(() => plan("write", normalizeRequirements({ ephemeral: true })), /requires fast/);
  assert.throws(() => plan("write", normalizeRequirements({ ephemeral: true, fast: true, semantic: true })), /persistent authoritative/);
});

test("shared validation rejects weakened guarantees and malformed dependency graphs", () => {
  const fast = plan("read", normalizeRequirements({ fast: true, lifetime: 30 }));
  const catalog: CapabilityCatalog = {
    database: { actions: ["get", "upsert"], persistent: true, strong: true, ttl: true },
    cache: { actions: ["get", "put"], ttl: true, minimumTTL: 60 },
  };
  assert.throws(() => validateCapabilities(fast, catalog), /TTL must be at least 60/);
  assert.throws(() => validateCapabilities(plan("read", normalizeRequirements({ fast: true, realtime: true })), catalog), /strong consistency/);
  assert.throws(() => validateCapabilities(plan("write", normalizeRequirements({ later: true })), catalog), /Missing capability: queue/);
  const broken = plan("read");
  broken.steps[0].dependsOn = ["missing"];
  assert.throws(() => validateCapabilities(broken, catalog), /earlier step/);
});

test("friendly requirements translate once to the canonical executable contract", () => {
  const requirements = normalizeRequirements({ speed: "fast", consistency: "fresh", execution: "later",
    lifetime: { ttlMs: 120_000 }, search: { lexical: ["title"], semantic: ["body"] } });
  assert.equal(requirements.cache, "write-through");
  assert.equal(requirements.freshness, "fresh");
  assert.equal(requirements.execution, "deferred");
  assert.equal(requirements.lifetime, 120);
  assert.deepEqual(requirements.searchable, ["title"]);
  assert.deepEqual(requirements.semantic, ["body"]);
  assert.equal(normalizeRequirements({ lifetime: { expiresAt: "2026-10-09T00:02:00Z" } },
    Date.parse("2026-10-09T00:00:00Z") / 1000).lifetime, 120);
  assert.throws(() => normalizeRequirements({ persistent: true, ephemeral: true }), /conflicts/);
});

test("a non-Cloudflare provider plugs into the same conductor and preserves cached undefined", async () => {
  class MemoryProvider extends CloudProvider {
    readonly id = "memory";
    reads = 0;
    row?: AuthorityResult;
    cache?: { hit: boolean; value?: unknown };
    readonly services: CloudProviderServices = {
      database: {
        get: async () => { this.reads++; return this.row ?? { kind: "authority", hit: false, expiresAt: null }; },
        upsert: async context => this.row = { kind: "authority", hit: true, value: context.input,
          version: context.plan.id, expiresAt: null },
        hydrate: async () => [], delete: async () => { this.row = undefined; },
      },
      cache: {
        get: async () => this.cache ?? { hit: false },
        put: async context => {
          assert.equal(context.authority?.version, this.row?.version);
          this.cache = { hit: true, value: context.input };
        },
        invalidate: async () => { this.cache = undefined; },
      },
    };
    capabilities(): CapabilityCatalog {
      return { database: { actions: ["upsert", "get", "delete", "hydrate"], persistent: true },
        cache: { actions: ["get", "put", "invalidate"] } };
    }
    protected validateProviderPlan(): void {}
  }
  const provider = new MemoryProvider();
  const cloud = new Cloud({ provider, defaults: { persistent: true, fast: true } });
  await cloud.Write("value:1", undefined);
  assert.equal(await cloud.Read("value:1"), undefined);
  assert.equal(await cloud.Read("value:1"), undefined);
  assert.equal(provider.reads, 1);
});
