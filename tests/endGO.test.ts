import { describe, expect, test } from 'bun:test';
import {
  createReply,
  endGO,
  RegExRouter,
  TrieRouter,
  type endGOLogger,
  type ExecutionContext,
  type ExtractParams,
} from '../src/index.js';

const silentLogger: endGOLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

describe('endGO pipeline, middleware scoping, and immutability', () => {
  test('executes global, wildcard, and parameterized middlewares in onion order', async () => {
    const app = new endGO({ logger: silentLogger });
    const trace: string[] = [];

    app.mid('*', async (_ctx, next) => {
      trace.push('global:before');
      const res = await next();
      trace.push('global:after');
      return res;
    });

    app.mid('/api/*', async (_ctx, next) => {
      trace.push('api:before');
      const res = await next();
      trace.push('api:after');
      return res;
    });

    app.mid('/tasks/:id', async (_ctx, next) => {
      trace.push('tasks-param:before');
      const res = await next();
      trace.push('tasks-param:after');
      return res;
    });

    app.end('/api/tasks', ({ server }) => {
      trace.push('handler:/api/tasks');
      return server.reply(200, { ok: true });
    });

    app.end('/tasks/:id', ({ server, request }) => {
      trace.push(`handler:/tasks/${request.resolved.params.id}`);
      return server.reply(200, { id: request.resolved.params.id });
    });

    const apiRes = await app.fetch(new Request('https://example.com/api/tasks'));
    expect(apiRes.status).toBe(200);
    expect(trace).toEqual([
      'global:before',
      'api:before',
      'handler:/api/tasks',
      'api:after',
      'global:after',
    ]);

    trace.length = 0;
    const taskRes = await app.fetch(new Request('https://example.com/tasks/42'));
    expect(taskRes.status).toBe(200);
    expect(trace).toEqual([
      'global:before',
      'tasks-param:before',
      'handler:/tasks/42',
      'tasks-param:after',
      'global:after',
    ]);
  });

  test('freezes HandlerContext and hydrated requestor snapshot at handler boundary', async () => {
    const app = new endGO({ logger: silentLogger });

    app.mid('*', async (context, next) => {
      context.requestor = Object.freeze({
        ...context.requestor,
        user: { id: 'u_99' },
        tenant: { id: 't_7' },
        roles: ['admin'],
        permissions: ['tasks:write'],
        authProvider: 'bearer',
      });
      return next();
    });

    let assertionsRan = false;
    app.end('/protected', (context) => {
      assertionsRan = true;
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.requestor)).toBe(true);
      expect(Object.isFrozen(context.requestor.roles)).toBe(true);
      expect(Object.isFrozen(context.requestor.permissions)).toBe(true);
      expect(Object.isFrozen(context.requestor.device)).toBe(true);

      expect(() => {
        (context as unknown as Record<string, unknown>).requestor = null;
      }).toThrow(TypeError);

      expect(() => {
        (context.requestor as unknown as Record<string, unknown>).user = null;
      }).toThrow(TypeError);

      expect(() => {
        (context.requestor.roles as string[]).push('superadmin');
      }).toThrow(TypeError);

      return context.server.reply(200, {
        user: context.requestor.user,
        roles: context.requestor.roles,
      });
    });

    const res = await app.fetch(new Request('https://example.com/protected'));
    expect(assertionsRan).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: 'u_99' },
      roles: ['admin'],
    });
  });

  test('returns 404 for unknown routes and 405 with Allow header for disallowed verbs', async () => {
    const app = new endGO({ logger: silentLogger });
    app.end('/items', {
      GET: ({ server }) => server.reply(200, { items: [] }),
      POST: ({ server }) => server.reply(201, { created: true }),
    });

    const notFound = await app.fetch(new Request('https://example.com/missing'));
    expect(notFound.status).toBe(404);

    const methodNotAllowed = await app.fetch(
      new Request('https://example.com/items', { method: 'DELETE' })
    );
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get('Allow')).toBe('GET, POST, HEAD');
  });

  test('HEAD strips response body while preserving status and headers', async () => {
    const app = new endGO({ logger: silentLogger });
    app.end('/ping', {
      GET: ({ server }) =>
        server.reply(200, { pong: true }, { 'X-Ping': '1' }),
    });

    const headRes = await app.fetch(
      new Request('https://example.com/ping', { method: 'HEAD' })
    );
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('X-Ping')).toBe('1');
    expect(headRes.headers.get('Content-Type')).toBe(
      'application/json; charset=utf-8'
    );
    expect(headRes.body).toBeNull();
  });

  test('isolates per-request CF Worker env and ctx across concurrent fetch calls, including destructured fetch', async () => {
    interface WorkerEnv {
      TENANT_ID: string;
    }

    const app = new endGO<WorkerEnv>({
      Environment: { TENANT_ID: 'base' },
      logger: silentLogger,
    });

    app.end('/whoami', async ({ server }) => {
      await Promise.resolve();
      const waited: string[] = [];
      server.ctx?.waitUntil(
        Promise.resolve().then(() => {
          waited.push(server.env.TENANT_ID);
        })
      );
      return server.reply(200, {
        tenant: server.env.TENANT_ID,
        hasCtx: Boolean(server.ctx),
      });
    });

    const { fetch } = app;

    const ctxAPromises: Promise<unknown>[] = [];
    const ctxBPromises: Promise<unknown>[] = [];
    const ctxA: ExecutionContext = { waitUntil: (p) => ctxAPromises.push(p) };
    const ctxB: ExecutionContext = { waitUntil: (p) => ctxBPromises.push(p) };

    const [resA, resB, resDefault] = await Promise.all([
      fetch(new Request('https://example.com/whoami'), { TENANT_ID: 'alpha' }, ctxA),
      fetch(new Request('https://example.com/whoami'), { TENANT_ID: 'beta' }, ctxB),
      fetch(new Request('https://example.com/whoami')),
    ]);

    expect(await resA.json()).toEqual({ tenant: 'alpha', hasCtx: true });
    expect(await resB.json()).toEqual({ tenant: 'beta', hasCtx: true });
    expect(await resDefault.json()).toEqual({ tenant: 'base', hasCtx: false });
    expect(ctxAPromises.length).toBe(1);
    expect(ctxBPromises.length).toBe(1);
  });

  test('silence() dynamically removes routes and returns 404 afterwards', async () => {
    const app = new endGO({ logger: silentLogger });
    app.end('/beta', ({ server }) => server.reply(200, { beta: true }));

    const before = await app.fetch(new Request('https://example.com/beta'));
    expect(before.status).toBe(200);

    expect(app.silence('/beta')).toBe(true);
    expect(app.silence('/beta')).toBe(false);

    const after = await app.fetch(new Request('https://example.com/beta'));
    expect(after.status).toBe(404);
  });

  test('supports custom PathResolver and RegExRouter IoC injection', async () => {
    const app = new endGO({
      Router: new RegExRouter(),
      Resolver: (path) => (path.startsWith('/v1') ? path.slice(3) || '/' : path),
      logger: silentLogger,
    });

    app.end('/tasks/:id', ({ request, server }) =>
      server.reply(200, { id: request.resolved.params.id })
    );

    const res = await app.fetch(new Request('https://example.com/v1/tasks/77'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: '77' });
  });

  test('emits "error" lifecycle event and returns 500 when handler throws', async () => {
    const app = new endGO({ logger: silentLogger });
    const capturedErrors: unknown[] = [];

    app.on('error', (err) => {
      capturedErrors.push(err);
    });

    app.end('/boom', () => {
      throw new Error('kaboom');
    });

    const res = await app.fetch(new Request('https://example.com/boom'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal Server Error' });
    expect(capturedErrors.length).toBe(1);
    expect((capturedErrors[0] as Error).message).toBe('kaboom');
  });
});

describe('Wave 1: typed params, services, notFound, onError, mount, group, and HTTP hardening', () => {
  test('infers ExtractParams<Path>, Pick<Env>, TServices, and TUser across end() and group()', async () => {
    interface FullEnv {
      DB_NAME: string;
      API_KEY: string;
    }
    interface Services {
      clock: () => number;
    }
    interface User {
      id: string;
      email: string;
    }

    // Compile-time assertion for ExtractParams
    type PostParams = ExtractParams<'/users/:id/posts/:postId'>;
    const sampleParams: PostParams = { id: 'u1', postId: 'p2' };
    expect(sampleParams).toEqual({ id: 'u1', postId: 'p2' });

    const app = new endGO<Pick<FullEnv, 'DB_NAME'>, Services, User>({
      Environment: { DB_NAME: 'primary-db' },
      services: { clock: () => 1700000000 },
      logger: silentLogger,
    });

    app.mid('*', async (ctx, next) => {
      ctx.requestor = Object.freeze({
        ...ctx.requestor,
        user: { id: 'user_1', email: 'dev@example.com' },
      });
      return next();
    });

    app.end('/users/:id/posts/:postId', ({ request, requestor, server }) => {
      const userId: string = request.resolved.params.id;
      const postId: string = request.resolved.params.postId;
      const now: number = server.services.clock();
      const db: string = server.env.DB_NAME;
      const email: string | undefined = requestor.user?.email;

      return server.reply(200, { userId, postId, now, db, email });
    });

    const orgGroup = app.group('/orgs/:orgId');
    orgGroup.end('/items/:itemId', ({ request, server }) => {
      const orgId: string = request.resolved.params.orgId;
      const itemId: string = request.resolved.params.itemId;
      return server.reply(200, { orgId, itemId });
    });

    const res = await app.fetch(
      new Request('https://example.com/users/u9/posts/p42')
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: 'u9',
      postId: 'p42',
      now: 1700000000,
      db: 'primary-db',
      email: 'dev@example.com',
    });

    const orgRes = await app.fetch(
      new Request('https://example.com/orgs/acme/items/i7')
    );
    expect(orgRes.status).toBe(200);
    expect(await orgRes.json()).toEqual({ orgId: 'acme', itemId: 'i7' });
  });

  test('supports app.notFound() and endGOOptions.onNotFound', async () => {
    const app1 = new endGO({ logger: silentLogger }).notFound(({ request, server }) =>
      server.reply(404, { customNotFound: true, path: request.resolved.url.pathname })
    );

    const res1 = await app1.fetch(new Request('https://example.com/nope'));
    expect(res1.status).toBe(404);
    expect(await res1.json()).toEqual({ customNotFound: true, path: '/nope' });

    const app2 = new endGO({
      logger: silentLogger,
      onNotFound: ({ server }) => server.reply(404, 'Custom 404 Text'),
    });
    const res2 = await app2.fetch(new Request('https://example.com/missing'));
    expect(res2.status).toBe(404);
    expect(await res2.text()).toBe('Custom 404 Text');
  });

  test('supports app.onError() and endGOOptions.onError while still logging and emitting error event', async () => {
    const logged: unknown[] = [];
    const emitted: unknown[] = [];
    const customLogger: endGOLogger = {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: (msg, ...meta) => logged.push([msg, ...meta]),
    };

    const app = new endGO({
      logger: customLogger,
      onError: (err, { server }) =>
        server.reply(502, {
          handled: true,
          message: err instanceof Error ? err.message : String(err),
        }),
    });

    app.on('error', (err) => {
      emitted.push(err);
    });

    app.end('/fail', () => {
      throw new Error('upstream down');
    });

    const res = await app.fetch(new Request('https://example.com/fail'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      handled: true,
      message: 'upstream down',
    });
    expect(logged.length).toBe(1);
    expect(emitted.length).toBe(1);

    app.onError((_err, { server }) => server.reply(503, { override: true }));
    const res2 = await app.fetch(new Request('https://example.com/fail'));
    expect(res2.status).toBe(503);
    expect(await res2.json()).toEqual({ override: true });
  });

  test('supports app.mount() with prefix stripping, middleware composition, sub-apps, and 404/405 interaction', async () => {
    const authSubApp = new endGO({ logger: silentLogger });
    authSubApp.end('/', ({ server }) => server.reply(200, { authRoot: true }));
    authSubApp.end('/session', {
      GET: ({ server }) => server.reply(200, { session: 'active' }),
    });
    authSubApp.end('/sign-in', {
      POST: async ({ request, server }) => {
        const body = await request.resolved.body?.json<{ email: string }>();
        return server.reply(200, { signedIn: body?.email ?? null });
      },
    });

    const app = new endGO({ logger: silentLogger });
    const trace: string[] = [];

    app.mid('/api/*', async (_ctx, next) => {
      trace.push('parent:api');
      const res = await next();
      res.headers.set('X-Parent-Middleware', 'applied');
      return res;
    });

    // Explicit route on parent takes precedence and preserves 405
    app.end('/api/auth/health', {
      GET: ({ server }) => server.reply(200, { authHealth: 'ok' }),
    });

    app.mount('/api/auth/*', authSubApp);
    app.mount('/fn', (req) =>
      new Response(JSON.stringify({ pathname: new URL(req.url).pathname }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const rootRes = await app.fetch(new Request('https://example.com/api/auth'));
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get('X-Parent-Middleware')).toBe('applied');
    expect(await rootRes.json()).toEqual({ authRoot: true });
    expect(trace).toEqual(['parent:api']);

    const sessionRes = await app.fetch(
      new Request('https://example.com/api/auth/session')
    );
    expect(sessionRes.status).toBe(200);
    expect(await sessionRes.json()).toEqual({ session: 'active' });

    const signInRes = await app.fetch(
      new Request('https://example.com/api/auth/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.com' }),
      })
    );
    expect(signInRes.status).toBe(200);
    expect(await signInRes.json()).toEqual({ signedIn: 'ada@example.com' });

    // Explicit parent route 405 interaction
    const health405 = await app.fetch(
      new Request('https://example.com/api/auth/health', { method: 'POST' })
    );
    expect(health405.status).toBe(405);
    expect(health405.headers.get('Allow')).toBe('GET, HEAD');

    // Function mount handler
    const fnRes = await app.fetch(new Request('https://example.com/fn/hello/world'));
    expect(fnRes.status).toBe(200);
    expect(await fnRes.json()).toEqual({ pathname: '/hello/world' });

    // Sibling path should NOT match /fn mount
    const notFnRes = await app.fetch(new Request('https://example.com/fn2/hello'));
    expect(notFnRes.status).toBe(404);
  });

  test('supports app.group() with scoped middleware and nested groups', async () => {
    const app = new endGO({ logger: silentLogger });
    const trace: string[] = [];

    const api = app.group('/api', async (_ctx, next) => {
      trace.push('api');
      return next();
    });

    const v2 = api.group('/v2', async (_ctx, next) => {
      trace.push('v2');
      return next();
    });

    v2.end('/status', ({ server }) => {
      trace.push('status');
      return server.reply(200, { version: 2 });
    });

    app.end('/public', ({ server }) => {
      trace.push('public');
      return server.reply(200, { public: true });
    });

    const pubRes = await app.fetch(new Request('https://example.com/public'));
    expect(pubRes.status).toBe(200);
    expect(trace).toEqual(['public']);

    trace.length = 0;
    const v2Res = await app.fetch(new Request('https://example.com/api/v2/status'));
    expect(v2Res.status).toBe(200);
    expect(await v2Res.json()).toEqual({ version: 2 });
    expect(trace).toEqual(['api', 'v2', 'status']);
  });

  test('decodes :param segments with decodeURIComponent and falls back on malformed % sequences', () => {
    for (const router of [new TrieRouter(), new RegExRouter()]) {
      router.listen('/files/:name', () => new Response('ok'));

      const decoded = router.match('/files/hello%20world%2B1', 'GET');
      expect(decoded?.params).toEqual({ name: 'hello world+1' });

      const malformed = router.match('/files/bad%E0%A4%A', 'GET');
      expect(malformed?.params).toEqual({ name: 'bad%E0%A4%A' });
    }
  });

  test('createReply preserves repeated Set-Cookie headers from string[] and Headers', () => {
    const reply = createReply();

    const fromArray = reply(
      200,
      { ok: true },
      {
        'Set-Cookie': ['session=abc; Path=/; HttpOnly', 'csrf=xyz; Path=/'],
        'X-Custom': 'yes',
      }
    );
    expect(fromArray.headers.getSetCookie()).toEqual([
      'session=abc; Path=/; HttpOnly',
      'csrf=xyz; Path=/',
    ]);
    expect(fromArray.headers.get('X-Custom')).toBe('yes');

    const incomingHeaders = new Headers();
    incomingHeaders.append('Set-Cookie', 'a=1; Path=/');
    incomingHeaders.append('Set-Cookie', 'b=2; Path=/');
    incomingHeaders.set('X-Trace', 't-1');

    const fromHeaders = reply(200, { ok: true }, incomingHeaders);
    expect(fromHeaders.headers.getSetCookie()).toEqual([
      'a=1; Path=/',
      'b=2; Path=/',
    ]);
    expect(fromHeaders.headers.get('X-Trace')).toBe('t-1');
  });
});

// Neutral API integration fixture (WorkspaceItems)
interface WorkspaceItem {
  id: string;
  tenantId: string;
  title: string;
  completed: boolean;
  createdFromMobile: boolean;
  createdAt: string;
}

interface WorkspaceItemsEnv {
  ITEM_STORE: Map<string, WorkspaceItem>;
  API_SECRET: string;
}

function createWorkspaceItemsApp() {
  const app = new endGO<WorkspaceItemsEnv>({
    Environment: {
      ITEM_STORE: new Map<string, WorkspaceItem>(),
      API_SECRET: 'workspace-dev-secret',
    },
    logger: silentLogger,
  });

  app.mid('*', async (ctx, next) => {
    const start = Date.now();
    const res = await next();
    res.headers.set('X-Powered-By', 'endGO');
    res.headers.set('X-Response-Time', `${Date.now() - start}ms`);
    return res;
  });

  app.end('/health', ({ server }) =>
    server.reply(200, { status: 'ok', service: 'workspace-items' })
  );

  const api = app.group('/api', async (ctx, next) => {
    const auth = ctx.request.resolved.headers.get('authorization');
    const expected = `Bearer ${ctx.server.env.API_SECRET}`;
    if (auth !== expected) {
      return ctx.server.reply(401, { error: 'Unauthorized' });
    }
    const tenantId = ctx.request.resolved.headers.get('x-tenant-id') ?? 'default';
    ctx.requestor = Object.freeze({
      ...ctx.requestor,
      user: { id: 'svc-user' },
      tenant: { id: tenantId },
      authProvider: 'bearer',
    });
    return next();
  });

  api.end('/items', {
    GET: ({ requestor, server }) => {
      const tenantId = (requestor.tenant as { id: string }).id;
      const items = [...server.env.ITEM_STORE.values()].filter(
        (item) => item.tenantId === tenantId
      );
      return server.reply(200, { tenantId, items });
    },
    POST: async ({ request, requestor, server }) => {
      const tenantId = (requestor.tenant as { id: string }).id;
      const payload = await request.resolved.body?.json<{ title?: string }>();
      const item: WorkspaceItem = {
        id: crypto.randomUUID(),
        tenantId,
        title: payload?.title ?? 'Untitled',
        completed: false,
        createdFromMobile: Boolean(requestor.device.isMobile),
        createdAt: new Date().toISOString(),
      };
      server.env.ITEM_STORE.set(item.id, item);
      server.ctx?.waitUntil(Promise.resolve(item.id));
      return server.reply(201, { item });
    },
  });

  api.end('/items/:id', {
    GET: ({ request, requestor, server }) => {
      const tenantId = (requestor.tenant as { id: string }).id;
      const item = server.env.ITEM_STORE.get(request.resolved.params.id);
      if (!item || item.tenantId !== tenantId) {
        return server.reply(404, { error: 'Item not found' });
      }
      return server.reply(200, { item });
    },
    PATCH: async ({ request, requestor, server }) => {
      const tenantId = (requestor.tenant as { id: string }).id;
      const existing = server.env.ITEM_STORE.get(request.resolved.params.id);
      if (!existing || existing.tenantId !== tenantId) {
        return server.reply(404, { error: 'Item not found' });
      }
      const patch = await request.resolved.body?.json<{
        title?: string;
        completed?: boolean;
      }>();
      const updated: WorkspaceItem = {
        ...existing,
        title: patch?.title ?? existing.title,
        completed: patch?.completed ?? existing.completed,
      };
      server.env.ITEM_STORE.set(updated.id, updated);
      return server.reply(200, { item: updated });
    },
    DELETE: ({ request, requestor, server }) => {
      const tenantId = (requestor.tenant as { id: string }).id;
      const existing = server.env.ITEM_STORE.get(request.resolved.params.id);
      if (!existing || existing.tenantId !== tenantId) {
        return server.reply(404, { error: 'Item not found' });
      }
      server.env.ITEM_STORE.delete(existing.id);
      return server.reply(204);
    },
  });

  return app;
}

describe('WorkspaceItems API integration', () => {
  const AUTH_HEADERS = {
    Authorization: 'Bearer workspace-dev-secret',
    'x-tenant-id': 'acme',
    'content-type': 'application/json',
  };

  test('serves public /health and enforces Bearer auth on /api/*', async () => {
    const app = createWorkspaceItemsApp();

    const health = await app.fetch(new Request('https://workspace.test/health'));
    expect(health.status).toBe(200);
    expect(health.headers.get('X-Powered-By')).toBe('endGO');
    expect(health.headers.get('X-Response-Time')).toMatch(/ms$/);
    expect(await health.json()).toEqual({
      status: 'ok',
      service: 'workspace-items',
    });

    const noAuth = await app.fetch(new Request('https://workspace.test/api/items'));
    expect(noAuth.status).toBe(401);

    const badAuth = await app.fetch(
      new Request('https://workspace.test/api/items', {
        headers: { Authorization: 'Bearer wrong-token' },
      })
    );
    expect(badAuth.status).toBe(401);
  });

  test('performs full CRUD lifecycle, lazy device inspection, waitUntil, and 405 handling', async () => {
    const app = createWorkspaceItemsApp();
    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx: ExecutionContext = {
      waitUntil: (p) => waitUntilPromises.push(p),
    };
    const workerEnv: Partial<WorkspaceItemsEnv> = {
      ITEM_STORE: new Map<string, WorkspaceItem>(),
      API_SECRET: 'worker-secret-123',
    };
    const headers = {
      Authorization: 'Bearer worker-secret-123',
      'x-tenant-id': 'tenant-alpha',
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    };

    // POST /api/items
    const createRes = await app.fetch(
      new Request('https://workspace.test/api/items', {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Verify endGO MVP' }),
      }),
      workerEnv,
      ctx
    );
    expect(createRes.status).toBe(201);
    const createdBody = (await createRes.json()) as { item: WorkspaceItem };
    expect(createdBody.item.title).toBe('Verify endGO MVP');
    expect(createdBody.item.completed).toBe(false);
    expect(createdBody.item.tenantId).toBe('tenant-alpha');
    expect(createdBody.item.createdFromMobile).toBe(true);
    expect(waitUntilPromises.length).toBe(1);
    await Promise.all(waitUntilPromises);

    const itemId = createdBody.item.id;

    // GET /api/items
    const listRes = await app.fetch(
      new Request('https://workspace.test/api/items', { headers }),
      workerEnv,
      ctx
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      tenantId: string;
      items: WorkspaceItem[];
    };
    expect(listBody.tenantId).toBe('tenant-alpha');
    expect(listBody.items.length).toBe(1);
    expect(listBody.items[0].id).toBe(itemId);

    // GET /api/items/:id
    const getRes = await app.fetch(
      new Request(`https://workspace.test/api/items/${itemId}`, { headers }),
      workerEnv,
      ctx
    );
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as { item: WorkspaceItem }).item.id).toBe(itemId);

    // PATCH /api/items/:id
    const patchRes = await app.fetch(
      new Request(`https://workspace.test/api/items/${itemId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ completed: true, title: 'Ship endGO MVP' }),
      }),
      workerEnv,
      ctx
    );
    expect(patchRes.status).toBe(200);
    const patchedBody = (await patchRes.json()) as { item: WorkspaceItem };
    expect(patchedBody.item.completed).toBe(true);
    expect(patchedBody.item.title).toBe('Ship endGO MVP');

    // 405 on unsupported verb PUT /api/items
    const putRes = await app.fetch(
      new Request('https://workspace.test/api/items', {
        method: 'PUT',
        headers,
      }),
      workerEnv,
      ctx
    );
    expect(putRes.status).toBe(405);
    expect(putRes.headers.get('Allow')).toBe('GET, POST, HEAD');

    // DELETE /api/items/:id
    const deleteRes = await app.fetch(
      new Request(`https://workspace.test/api/items/${itemId}`, {
        method: 'DELETE',
        headers,
      }),
      workerEnv,
      ctx
    );
    expect(deleteRes.status).toBe(204);
    expect(deleteRes.body).toBeNull();

    // Confirm deleted item returns 404
    const afterDelete = await app.fetch(
      new Request(`https://workspace.test/api/items/${itemId}`, { headers }),
      workerEnv,
      ctx
    );
    expect(afterDelete.status).toBe(404);
  });

  test('uses default Environment when no workerEnv is provided', async () => {
    const app = createWorkspaceItemsApp();
    const res = await app.fetch(
      new Request('https://workspace.test/api/items', {
        headers: AUTH_HEADERS,
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: 'acme', items: [] });
  });
});
