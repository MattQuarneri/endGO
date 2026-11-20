# Data-first code generation plan

Teach endGO to read two metadata files — the API's shape (`api.openAPI.json`) and the data's shape (`database.sql`) — and generate the imperative code between them: endpoints, validation, auth, SQL, and the business-logic seams. Hand-written logic plugs into those seams and survives regeneration.

Reference: [CloudC developer guide](../src/cloudC%20README.md), [CloudC plan](./cloudC.plan.md), [endpoint modules](../src/endpoint.ts), [validate middleware](../src/builtins/validate.ts). The first worked example is BetaBug (`taskimatic.com/betabug/betabug.openAPI.json` and `betabug.sql`).

## Why, and how it differs from Chanfana

Cloudflare's `chanfana-openapi-template` is **code-first**: you write Hono routes plus Zod classes (`D1CreateEndpoint`, `D1ListEndpoint`), and Chanfana derives the OpenAPI document from the code. The spec is an output.

This plan is **data-first**: the spec and the SQL are the inputs and the source of truth. Code is an output, and most of it is disposable.

```text
api.openAPI.json ─┐                          ┌─ gen/types.ts, validators.ts
                  ├─ read ─▶ IR ─▶ bind ─▶ check ─▶ emit ─┼─ gen/endpoints/*.ts, app.ts
database.sql ─────┘   (endgo.ir.json)                 ├─ gen/sql.ts, migrations/
                                                      └─ logic/*.ts  (created once, then yours)
```

What to borrow from Chanfana: generic list/create/read/update/delete behaviour (search fields, default ordering, pagination), a consistent error envelope, and a docs page served from the spec. What to leave behind: the class hierarchy, the runtime dependency on Zod, and deriving the contract from code.

## The three layers

Generated code splits every request into three layers, so "payload in, system calls out" holds literally:

| Layer | Who writes it | Knows about | Doesn't know about |
| --- | --- | --- | --- |
| **Endpoint** (`gen/endpoints/`) | Generator, every run | HTTP: path, verbs, headers, status codes, `Prefer`, auth middleware, validation | Tables, SQL, business rules |
| **Operation** (`logic/`) | Generator once (default body), then you | A typed input payload, the frozen requestor, and ports | `Request`/`Response`, bindings, providers |
| **Ports** (CloudC) | endGO runtime + providers | D1, Postgres, KV, Queues, Workers AI… | HTTP, the spec |

### The operation contract

```ts
// endgo/ops — runtime, zero-dependency
export interface OpResult<O> {
  status: number;                 // must be one of the spec's declared responses
  body?: O;
  headers?: Record<string, string>;
}

export interface OpContext<TUser = unknown, TTenant = unknown> {
  requestor: Requestor<TUser, TTenant>;   // the same frozen snapshot endGO already builds
  now(): Date;
  id(): string;
  log: endGOLogger;
}

export type Operation<I, O, P> = (input: I, ctx: OpContext, ports: P) => Promise<OpResult<O>>;
```

An operation never sees a `Request`. That means the same operation can be called from an endpoint, a queue consumer, a CLI, or a test, and testing it is a matter of "given this payload, assert these port calls":

```ts
const ports = recordPorts(gen.ports);            // fakes that log every call
await submitReport(examplePayload, testContext(), ports);
expect(ports.calls).toEqual([{ port: 'db', action: 'call', fn: 'betabug.report', args: [examplePayload] }]);
```

### Ports are CloudC, plus one new capability

CloudC's verbs (`Write/Read/Delete` on refs) suit records, caches, search, queues and AI. They do **not** suit a declared relational schema: filters, column-level grants, views and SQL functions have nowhere to go, and the [CloudC plan](./cloudC.plan.md) deliberately keeps records in an envelope and puts shape-derived SQL out of scope.

Data-first doesn't contradict that. The schema here is **declared** (by `database.sql`), not inferred from runtime values. So the plan adds one capability to CloudC rather than routing tables through record refs:

| Capability | Actions | Connectors |
| --- | --- | --- |
| `table` (relational authority) | `select`, `insert`, `update`, `delete`, `call` (SQL function), `batch` | D1 (SQLite), Postgres over Hyperdrive or the Neon/Supabase HTTP drivers, PGlite and `bun:sqlite` for LandCloud |

- `Init.Table` takes the introspected catalog as its contract, so `Init` → `diff` → `Apply` becomes the migration path ("here's what `database.sql` adds since the last deploy").
- Everything else stays existing CloudC: an operation that wants caching, search, a queue or a model uses `cloud.Read/Write/Process/Think` with policy, exactly as today.
- The generated `Ports` type exposes only what the IR says the operation needs (`db` scoped to its tables and functions, plus `cloud` when the spec asks for caching or async), so the type system blocks a handler from reaching for something undeclared.

## Inputs and binding rules

### Files

```text
api/
  api.openAPI.json       the wire contract (OpenAPI 3.1; 3.0 accepted and upgraded)
  database.sql           the data contract (canonical dialect: Postgres — see decision 1)
  endgo.config.json      targets, dialect, base path, overrides that don't belong in either file
```

### How an operation finds its SQL

Binding is by **convention first, extension second**, and an operation the binder can't resolve gets a stub, not a guess.

| Spec shape | Bound to | Default operation body |
| --- | --- | --- |
| `GET /{table}` | `table.select` with the PostgREST filter subset | list with filters, `order`, `limit`/`offset`, `select` columns |
| `POST /{table}` | `table.insert` | insert body; honour `Prefer: return=representation` |
| `PATCH /{table}` | `table.update` with filters | refuses an unfiltered update (400) unless `x-endgo.allowUnfiltered` |
| `DELETE /{table}` | `table.delete` with filters | same unfiltered guard |
| `GET /{view}` | `table.select` on a view | read-only list |
| `GET\|POST /rpc/{fn}` | `table.call` | push the call down to the SQL function (Postgres) or stub it (D1) |
| `/{table}/{id}` style | `table.*` keyed on the primary key | single-row read/update/delete, 404 on miss |
| anything else | nothing | stub that returns 501 until you write it |

The convention is PostgREST's, deliberately: the BetaBug spec was written for PostgREST, and endGO can serve the same paths, so the widget doesn't change when you swap PostgREST for a Worker.

When the convention doesn't fit, an operation says so with `x-endgo`:

```jsonc
"get": {
  "operationId": "getConfig",
  "x-endgo": {
    "bind": { "call": "betabug.config" },          // or { "table": "reports", "action": "select" }
    "policy": { "fast": true, "ttl": 60 },          // CloudC policy → KV-cached result
    "invalidatedBy": ["poll_rules", "poll_questions", "status_records", "apps"],
    "logic": "custom"                               // emit a stub instead of the default body
  }
}
```

`policy` is passed straight to CloudC, so the spec can ask for caching, async execution (`"deferred": true` returns `202` with a job receipt), or search without the handler changing.

## Reading the SQL: execute it, don't parse it

Parsing Postgres DDL well is hard (dollar-quoted PL/pgSQL, nested comments — BetaBug already hit one). Instead, the reader **applies `database.sql` to a throwaway database and reads the catalog**:

- **Postgres dialect:** [PGlite](https://pglite.dev) (Postgres compiled to WASM, runs in-process in Bun/Node). Apply the file, then query `pg_catalog`/`information_schema` for schemas, tables, columns (type, nullability, default, identity), primary/foreign/unique keys, `CHECK` constraints, views and their columns, functions (argument names/types/defaults, return type, volatility, `SECURITY DEFINER`), roles, and grants including column grants.
- **SQLite dialect:** apply to in-memory SQLite and read `sqlite_schema` plus `PRAGMA table_info / foreign_key_list / index_list`.

This gives the real database's own interpretation, catches syntax errors as a side effect, and lets the same PGlite instance serve as LandCloud's local Postgres for dev and tests (including PL/pgSQL functions). A parser (`libpg-query`) is still useful for one thing the catalog can't give: `CHECK` expressions in structured form, so `answer IN ('a','b')` can become an enum in validators. Use it only for that.

## The IR

`endgo.ir.json` is the single intermediate every emitter reads and the thing `endgo check` reasons about. It's JSON so it can be diffed in review and consumed by other tools (docs, SDK generators).

```ts
interface EndgoIR {
  version: 1;
  info: { title: string; version: string };
  schemas: Record<string, JsonSchema>;              // resolved components, $refs inlined or named
  data: {
    dialect: 'postgres' | 'sqlite';
    relations: Relation[];                          // tables and views
    functions: SqlFunction[];
    roles: Role[];                                  // with table/column/function grants
  };
  security: Record<string, SecurityScheme>;
  operations: OperationIR[];
}

interface OperationIR {
  id: string;                                       // operationId (required; missing → check error)
  method: HttpMethod;
  path: string;                                     // OpenAPI form: /reports/{id}
  route: string;                                    // endGO form:   /reports/:id
  input: { params?: JsonSchema; query?: JsonSchema; headers?: JsonSchema; body?: JsonSchema };
  responses: Record<string, { schema?: JsonSchema; headers?: string[] }>;
  security: Array<Record<string, string[]>>;        // OpenAPI semantics: any entry may satisfy
  binding:
    | { kind: 'table'; relation: string; action: 'select' | 'insert' | 'update' | 'delete'; keyed?: boolean }
    | { kind: 'call'; fn: string; argMode: 'named' | 'singleJson' }
    | { kind: 'none' };
  policy?: CloudPolicy;
  invalidatedBy?: string[];
  logic: 'default' | 'custom';
  requiredRole?: string;                            // derived from grants — see Auth
}
```

## What gets emitted

```text
gen/                         overwritten on every run; header says "do not edit"
  ir.json
  types.ts                   component schemas → TS types; relations → Row/Insert/Update types
  validators.ts              JSON Schema → Standard Schema v1 validators (zero runtime deps)
  sql.ts                     parameterised statements per operation, as readable constants
  ports.ts                   per-operation Ports types + the factory that builds them from CloudC
  endpoints/<path>.ts        one defineEndpoint() per path, verbs mapped to operations
  auth.ts                    middleware per securityScheme, requestor hydration, role checks
  app.ts                     createApp(provider) → endGO instance with everything registered
  openapi.json               the spec as served at /openapi.json (+ a docs page, like Chanfana's)
  migrations/0001_init.sql   target-dialect DDL, when the target differs from the source dialect
logic/                       generation gap: created if missing, never overwritten
  <operationId>.ts           the default body, ready to edit
tests/contract/              generated from spec examples: request → expected status/schema
```

### Emitted endpoint, for illustration

```ts
// gen/endpoints/rpc.report.ts — generated
import { defineEndpoint } from 'endgo';
import { validate, getValidated } from 'endgo/middleware';
import { toResponse, fromContext } from 'endgo/ops';
import { Report } from '../validators.js';
import { portsFor } from '../ports.js';
import { submitReport } from '../../logic/submitReport.js';

export default defineEndpoint({
  id: 'submitReport',
  path: '/rpc/report',
  middleware: [validate({ json: Report })],
  actions: {
    POST: async (c) =>
      toResponse(c, await submitReport(getValidated<{ json: typeof Report }>(c.request).json,
                                       fromContext(c), portsFor.submitReport(c))),
  },
});
```

```ts
// logic/submitReport.ts — generated once, then yours
import type { Operation } from 'endgo/ops';
import type { Report, Accepted } from '../gen/types.js';
import type { SubmitReportPorts } from '../gen/ports.js';

export const submitReport: Operation<Report, Accepted, SubmitReportPorts> = async (input, ctx, { db }) => {
  const result = await db.call('betabug.report', [input]);     // pushdown to the SQL function
  return { status: 201, body: result };
};
```

### Emit code, keep it thin

Emitted code is readable and type-checked, and it calls a small runtime kit (`endgo/ops`, `endgo/rest`) for the parts that are the same everywhere: the PostgREST filter parser (column names whitelisted from the IR, values always bound as parameters), `Prefer` handling, the error envelope, and response serialisation. Statements that never vary are emitted as constants in `gen/sql.ts`, so a reviewer can grep for exactly what SQL an endpoint runs.

## Functions: push down or lift

SQL functions are where the "logic" in a data-first design lives, and what happens to them depends on the target:

| Target | Strategy | Result |
| --- | --- | --- |
| Postgres (Neon, Supabase, Hyperdrive to any Postgres) | **Push down** | The operation calls the function. Validation, size limits and inserts stay in SQL, as in `betabug.report`. The Worker adds typed I/O, auth and caching. |
| D1 / SQLite | **Lift** | SQLite has no stored procedures. The generator emits a stub with the function's typed signature, its `CHECK`-derived validation, and the statements it can infer; you port the body by hand. `endgo check` lists every lifted function as outstanding work. |
| LandCloud (PGlite) | Push down | Same as Postgres, so local dev runs the real functions. |

This is why decision 1 recommends Postgres as the canonical dialect: it's the only one where the SQL file can carry logic as well as shape.

## Auth: securitySchemes plus GRANTs

Two sources describe who may do what, and the generator joins them:

1. **`securitySchemes`** become authentication middleware: `http/bearer` → JWT verification (key from `env`, algorithm from config) or the existing `bearerAuth` builtin; `apiKey` → header/query key check. Each hydrates the frozen `requestor` with `roles`.
2. **GRANTs** become authorisation. Each scheme maps to a database role in `endgo.config.json` (`anonKey → betabug_web`, `bearerAuth → betabug_admin`). For every operation the checker verifies the mapped role holds the needed privilege (`EXECUTE` on the function, `UPDATE` on the columns being patched, `SELECT` on the view), and the endpoint enforces the same check at runtime. Column grants narrow the generated update validator: for BetaBug, `PATCH /reports` accepts only `triage_state` and `notes`.

Fail closed: an operation whose role can't be resolved, or whose grant is missing, is a check error, not an open endpoint. On Postgres targets the Worker can also `SET ROLE` per request so Postgres enforces the grants (and any RLS) itself; on D1 the generated check is the only enforcement.

Public operations (BetaBug's widget endpoints) get a generated reminder in `check` output that they need rate limiting; the plan adds an optional `x-endgo.rateLimit` that emits a Cloudflare Rate Limiting binding check.

## Keeping the two files honest: `endgo check`

Because neither file is derived from the other, they can drift. `endgo check` fails CI on:

- An operation with no `operationId`, or two with the same one.
- A convention-bound path naming a relation or function that doesn't exist.
- A request/response schema property with no matching column (or function argument / result field), or the reverse for required columns without a default.
- Type mismatches: `integer` vs `text`, `format: date-time` vs `timestamptz`, nullable vs `required`, `maxLength` vs `varchar(n)`, `enum` vs a `CHECK (x IN …)` list.
- A security requirement with no role mapping, or a role lacking the grant the operation needs.
- A lifted function (D1 target) whose logic file still contains the generated `TODO`.
- `x-endgo` keys it doesn't recognise (typos shouldn't silently do nothing).

It reports, it never auto-fixes: the SQL owns storage types and constraints, the spec owns the wire contract, and a human decides which one is wrong. For bootstrapping, `endgo scaffold-spec database.sql` drafts an OpenAPI file from the catalog (BetaBug's spec was produced this way by a throwaway Python script; that script is the prototype for this command).

## CLI

| Command | Does |
| --- | --- |
| `endgo ir` | Read both files, write `gen/ir.json`. |
| `endgo check` | Bind and run the consistency rules; non-zero exit on errors. |
| `endgo gen` | `check`, then emit `gen/`, create missing `logic/` files, emit contract tests. |
| `endgo gen --watch` | Regenerate when either file changes; pairs with `wrangler dev` / LandCloud. |
| `endgo diff` | Plan the migration from the deployed schema to `database.sql` (CloudC `Init.Table` → `diff`). |
| `endgo scaffold-spec` | Draft `api.openAPI.json` from `database.sql`. |

The generator lives in its own workspace package (`packages/gen`, published as `@endgo/gen`), so its dev-time dependencies (PGlite, a JSON Schema bundler, `libpg-query`) never reach the zero-dependency runtime.

## BetaBug as the worked example

Every BetaBug operation resolves by convention except caching on `getConfig`:

| Operation | Binding | Default body | Notes |
| --- | --- | --- | --- |
| `getConfig` `GET /rpc/config` | call `betabug.config(app, page, session_id)` | push down | Add `x-endgo.policy: { fast, ttl: 60 }` + `invalidatedBy`; unknown app → SQLSTATE `P0002` → 404 |
| `submitReport` `POST /rpc/report` | call `betabug.report(json)`, single-JSON arg | push down | Public; needs rate limiting |
| `submitPollResponse` `POST /rpc/poll_response` | call `betabug.poll_response(json)` | push down | Public; needs rate limiting |
| `listApps` … `deleteStatusRecords` (16 ops) | `table.*` on `apps`, `poll_rules`, `poll_questions`, `status_records` | CRUD with filters | `bearerAuth → betabug_admin` |
| `listReports`, `deleteReports` | `table.select/delete` on `reports` | CRUD | |
| `updateReports` | `table.update` on `reports` | CRUD | Column grant limits body to `triage_state`, `notes` |
| `listPollResponses`, `deletePollResponses` | `table.*` on `poll_responses` | CRUD | |
| `listPollResults` | `table.select` on view `poll_results` | read-only list | |

On a Postgres target the result is zero hand-written logic files. On a D1 target, `config`, `report` and `poll_response` become three lifted stubs (and `is_live`'s rollout hash needs a JS port that matches `hashtext`, or a switch to a hash both sides can compute).

## Phases

### Phase 0: Hand-written spike

Write, by hand, the exact code the generator should produce for BetaBug, running on a Worker against PGlite locally and Neon remotely. Point the `<beta-bug api=…>` widget at it.

**Done when:** the widget works unchanged against the Worker, and the hand-written files are committed as `packages/gen/fixtures/betabug/expected/`, the golden output the generator must reproduce.

### Phase 1: Readers and IR

- OpenAPI loader: resolve `$ref`s, upgrade 3.0 → 3.1, collect operations, normalise paths to endGO routes.
- SQL reader: PGlite and in-memory SQLite introspection; `libpg-query` for `CHECK` expressions.
- `endgo ir` command; snapshot tests on BetaBug and the Chanfana `tasks` example (translated to the two files).

**Done when:** `gen/ir.json` for BetaBug is stable and reviewed.

### Phase 2: Binder and checker

- Convention binding, `x-endgo` parsing, role mapping from config.
- Every rule in the check list above, each with a failing fixture.

**Done when:** `endgo check` passes on BetaBug and each seeded drift (renamed column, missing grant, typo'd extension) fails with a readable message pointing at both files.

### Phase 3: Runtime kit and the `table` capability

- `endgo/ops`: `Operation`, `OpContext`, `toResponse`, `fromContext`, `recordPorts`.
- `endgo/rest`: PostgREST filter subset, `Prefer`, error envelope, SQLSTATE → HTTP mapping.
- CloudC `table` capability and connectors: D1, Postgres (Hyperdrive and Neon HTTP), PGlite, `bun:sqlite`. Joins the [CloudC plan](./cloudC.plan.md)'s connector work (its Phase 1.2) and conformance suite (its Phase 4).

**Done when:** the Phase 0 spike is rewritten on the kit and gets shorter, and the conformance suite covers `table` on every connector.

### Phase 4: Emitters

Types, validators, SQL constants, ports, endpoints, auth, app, served spec, logic stubs, contract tests. Generation-gap handling: never touch an existing `logic/` file; warn when its exported type no longer matches.

**Done when:** `endgo gen` on BetaBug reproduces the Phase 0 golden output (modulo formatting), and the generated contract tests pass against LandCloud.

### Phase 5: Targets and migrations

- Postgres push-down target first (it's BetaBug's).
- D1 target: translate the portable subset of the catalog (tables, views, keys, defaults, `CHECK`s) to SQLite DDL, emit lifted stubs, and report unsupported features (PL/pgSQL, roles, RLS, sequences shared across tables) as check errors.
- `endgo diff` via `Init.Table`.

**Done when:** BetaBug deploys to both a Postgres-backed and a D1-backed Worker from the same two files, with the D1 one needing only the three ported function bodies.

### Phase 6: Developer experience

Watch mode, a docs page at `/` (Scalar or Swagger UI loaded from a CDN, like Chanfana's `docs_url`), `scaffold-spec`, and a `platforms/cloudflare` template that starts from the two files.

| Phase | Depends on | Rough size |
| --- | --- | --- |
| 0 spike | none | medium |
| 1 readers + IR | 0 | medium |
| 2 binder + checker | 1 | medium |
| 3 runtime kit + `table` | 0; CloudC Phase 1.2 for connectors | large |
| 4 emitters | 2, 3 | large |
| 5 targets + migrations | 4 | medium to large |
| 6 DX | 4 | small to medium |

Phases 1–2 and Phase 3 can run in parallel: the generator side and the runtime side only meet at the Phase 0 golden output.

## Decisions to settle before coding

1. **Canonical SQL dialect.** *Recommendation:* Postgres. It's the only dialect that can carry functions, roles and grants, PGlite makes it local and testable, and D1 becomes a translated target with a documented subset. The alternative (SQLite as canonical) keeps everything on D1 but moves all logic out of the SQL file.
2. **Emit code or interpret the IR at runtime.** *Recommendation:* emit, for readability, tree-shaking and type checking. An interpreted `app.mount(fromIR(ir))` mode is a cheap later add-on for prototyping, since both share the runtime kit.
3. **How much PostgREST to speak.** *Recommendation:* the subset BetaBug's spec uses: `eq, neq, gt, gte, lt, lte, like, ilike, in, is`, `order`, `limit`/`offset`, `select` (columns only, no embedding), `Prefer: return=representation|minimal`, and the profile headers. Anything else is a 400, not a silent ignore.
4. **Where per-operation behaviour lives.** *Recommendation:* in the spec as `x-endgo`, so the contract and its operational policy are reviewed together; `endgo.config.json` holds only target/environment settings.
5. **Which file wins on disagreement.** *Recommendation:* neither; `check` reports and a human fixes. SQL owns storage, the spec owns the wire.

## Risks and out of scope

- **PL/pgSQL on D1** is impossible; lifted functions are real hand-porting work, and two implementations of the same rule can diverge. Contract tests generated from spec examples are the guard.
- **PGlite coverage**: extensions it lacks (some PostGIS, `pg_cron`) make introspection fail. Fallback: introspect a real Postgres via `DATABASE_URL`.
- **Security**: generated public endpoints are only as safe as the grants. The checker fails closed, but rate limiting and abuse protection still need deliberate configuration.
- **Out of scope:** GraphQL, client SDK generation (the IR makes it easy later), multi-database operations, automatic data migrations beyond the DDL diff, and non-Cloudflare control-plane provisioning.
