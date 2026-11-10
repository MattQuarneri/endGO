# endGO: Endpoint Oriented HTTP Microservices Framework

Zero-dependency, IoC-driven Web Standard HTTP serving framework for Cloudflare Workers, Fastly Compute, Bun, Deno, and Node.js.

> **🚀 Deploy to the edge in 5 minutes!** See [PLATFORMS_QUICKREF.md](./PLATFORMS_QUICKREF.md) or [platforms/GETTING_STARTED.md](./platforms/GETTING_STARTED.md)

So why endGO over Hono? 
1. endGO emphasizes endpoint-oriented design.
   While Hono does `app.get('/path', handler)` and similar verb-mapped routes, endGO does `app.end('/path', handler)` focusing on endpoint-oriented design with immutable requestor context and IoC-driven dependency injection. That's fundamentally why we made endGO; clear endpoints.
2. Immutable requestor context, lazy body parsing, and IoC-driven dependency injection.
   Hono does not provide immutable requestor context or IoC-driven dependency injection out of the box, which can make managing complex request lifecycles more challenging.

For these two simple reasons we think endGO is ideal for building scalable and maintainable HTTP microservices.

Every handler receives an immutable tripartite context (`{ request, requestor, server }`):
- **`request`** — raw `Request` plus a lazy `resolved` Proxy (`url`, `params`, `query`, `cookies`, `accepts`, `ip`, `protocol`, `fresh`) and memoized pure-callback `body` accessors.
- **`requestor`** — frozen identity snapshot (`user`, `tenant`, `roles`, `permissions`, `locale`, `timezone`) with a lazy `device` Proxy that avoids parsing `User-Agent` until accessed.
- **`server`** — per-request scoped `env` and `ctx` (`ExecutionContext`), DI containers (`modules`, `services`, `cache`), `logger`, `router`, `reply()`, and lifecycle events.

## Quickstart (Cloudflare Workers)

```ts
import { endGO } from 'endGO';

type Env = {
  API_SECRET: string;
  TASK_NAMESPACE: KVNamespace;
};

const app = new endGO<Env>();

// Global middleware
app.mid('*', async (_ctx, next) => {
  const start = performance.now();
  const res = await next();
  const headers = new Headers(res.headers);
  headers.set('X-Response-Time', `${(performance.now() - start).toFixed(2)}ms`);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
});

// Scoped auth middleware + immutable Requestor hydration
app.mid('/api/*', async (context, next) => {
  const token = context.request.resolved.headers.get('authorization')?.replace('Bearer ', '');
  if (!token || token !== context.server.env.API_SECRET) {
    return context.server.reply(401, { error: 'Unauthorized' });
  }

  context.requestor = Object.freeze({
    ...context.requestor,
    user: { id: 'usr_1' },
    tenant: { id: 'acme' },
    roles: ['member'],
    authProvider: 'bearer',
  });

  return next();
});

// Public route
app.end('/health', ({ server }) =>
  server.reply(200, { status: 'ok' })
);

// Verb-mapped route with lazy pure-callback body parsing & lazy device inspection
app.end('/api/tasks', {
  GET: async ({ requestor, server }) =>
    server.reply(200, { tenant: requestor.tenant, tasks: [] }),

  POST: async ({ request, requestor, server }) => {
    if (!request.resolved.body) {
      return server.reply(400, { error: 'Body required' });
    }

    const task = await request.resolved.body.json<{ title: string }, Record<string, unknown>>(
      (data) => ({
        id: crypto.randomUUID(),
        title: data?.title ?? 'Untitled',
        mobile: requestor.device.isMobile,
      })
    );

    return server.reply(201, { task });
  },
});

export default app;
```

## Runtime Adapters

### Cloudflare Workers / Fastly Compute / Deno
`app.fetch` is bound as an arrow property, so `export default app` (or `Deno.serve(app.fetch)`) preserves `this` and isolates per-request `env` and `ExecutionContext`.

**Quick Start:** See [platforms/cloudflare/](./platforms/cloudflare/) and [platforms/fastly/](./platforms/fastly/) for ready-to-deploy configurations.

### Bun
```ts
// Either call app.listen() directly in Bun:
app.listen(3000, () => console.log('Listening on :3000'));

// Or use the explicit Bun adapter:
import { serveBun } from 'endGO/adapters/bun';
serveBun(app, { port: 3000, hostname: '0.0.0.0' });
```

### Node.js
```ts
import { serveNode } from 'endGO/adapters/node';

serveNode(app, { port: 3000 }, () => {
  console.log('Node server listening on :3000');
});
```

## Platform-Specific Deployments

endGO includes pre-configured launch scripts and boilerplate for rapid deployment:

| Platform | Path | Status |
|----------|------|--------|
| **Cloudflare Workers** | [platforms/cloudflare/](./platforms/cloudflare/) | ✅ Ready |
| **Fastly Compute** | [platforms/fastly/](./platforms/fastly/) | ✅ Ready |
| Deno Deploy | Use `.fetch` directly | ✅ Supported |
| Bun | Use `app.listen()` or `serveBun()` | ✅ Supported |
| Node.js | Use `serveNode()` adapter | ✅ Supported |

See the `platforms/` directory README for quick-start guides.

## Lazy Body & IoC Routers

- **Pure-callback body parsing**: `body.literal(cb)`, `body.json(cb)`, `body.object(cb)`, `body.form(cb)`, `body.files(cb)`, `body.blob(cb)`, plus unbuffered `body.stream`. Repeated or cross-accessor reads on the same request share a single memoized `arrayBuffer()` read.
- **Pluggable routers**: `TrieRouter` (default, `static > :param > *` priority) or `RegExRouter` from `endGO/routers` via `new endGO({ Router: new RegExRouter() })`.
- **Dynamic route removal**: `app.silence('/path')` unregisters a route at runtime.

## Scripts

```bash
bun run check   # TypeScript typecheck (tsc --noEmit)
bun run build   # Compile dist/
bun test        # Run test suite
```
