# Local SQLite and Worker D1 with CloudC

[`app.ts`](./app.ts) defines the same endGO routes for both runtimes. The routes call `CloudC.Write`, `Read`, and `Delete`. [`local.ts`](./local.ts) passes a Bun SQLite provider and [`worker.ts`](./worker.ts) passes the Worker's D1 binding. Each profile keeps its own data. Both providers use the same SQL schema and CloudC value codec.

## Run on Bun with SQLite

From the repository root, run:

```sh
bun run dev:storage
```

The app listens on `127.0.0.1:3000`. It creates `.local/storage.sqlite` under this example on first run. Use `ENDGO_DB_PATH` to select a different database, `ENDGO_PORT` to change the port, and `ENDGO_STORAGE_TOKEN` to override the local demo token.

```sh
curl -sS http://127.0.0.1:3000/health
curl -sS -X PUT http://127.0.0.1:3000/records/hello \
  -H 'Authorization: Bearer local-demo' -H 'Content-Type: application/json' \
  -d '{"title":"Hello from CloudC"}'
curl -sS http://127.0.0.1:3000/records/hello \
  -H 'Authorization: Bearer local-demo'
```

Restart Bun and repeat the GET to check persistence. `DELETE /records/hello` removes the record.

## Run the exact Worker entry point locally

From the repository root, run:

```sh
npm --prefix platforms/cloudflare install
npm --prefix platforms/cloudflare run db:storage:local
npm --prefix platforms/cloudflare run dev:storage
```

Repeat the same requests using port `8787`. `/health` identifies the active backend. Wrangler runs the Worker and an isolated local D1 binding. Its SQLite state is managed by Wrangler. The Bun profile retains its own file. Use the Wrangler profile to check Worker behavior such as binding availability, SQL support and the bundle before deployment. [D1 local development](https://developers.cloudflare.com/d1/best-practices/local-development/).

## Deploy to Cloudflare

From `platforms/cloudflare`, create or choose a D1 database. Put its real ID and database name in [`wrangler.storage.toml`](../../platforms/cloudflare/wrangler.storage.toml), keeping the binding named `DB`. Apply the schema to that database, set a strong demo token as a Worker secret, and deploy the same Worker entry point used locally. [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

```sh
npx wrangler d1 execute DB --config wrangler.storage.toml --remote \
  --file ../../src/adapters/cloudflare.sql
npx wrangler secret put ENDGO_STORAGE_TOKEN --config wrangler.storage.toml
npx wrangler deploy --config wrangler.storage.toml
```

This example exercises persistent structured records. CloudC rejects capabilities the chosen provider cannot fulfill. Add bindings and parity tests when a service needs capabilities such as KV caching, R2, or Queues. For an existing application, inject the CloudC provider at startup in the same way and keep the provider imports in the runtime entry points.
