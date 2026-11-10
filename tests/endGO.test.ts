import { describe, expect, test } from 'bun:test';
import {
  endGO,
  RegExRouter,
  type endGOLogger,
  type ExecutionContext,
} from '../src/index.js';
import {
  createInMemoryTaskNamespace,
  createTaskimaticApp,
  type TaskRecord,
  type TaskimaticEnv,
} from '../examples/taskimatic-worker.js';

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
    interface WorkerEnv extends Record<string, unknown> {
      TENANT_ID: string;
    }

    const app = new endGO<WorkerEnv>({
      Environment: { TENANT_ID: 'base' },
      logger: silentLogger,
    });

    app.end('/whoami', async ({ server }) => {
      // Yield across microtasks to test interleaving concurrency
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

    // Destructure fetch directly to verify `this`-less binding
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

describe('Taskimatic PoC integration', () => {
  const AUTH_HEADERS = {
    Authorization: 'Bearer taskimatic-dev-secret',
    'x-tenant-id': 'acme',
    'content-type': 'application/json',
  };

  test('serves public /health and enforces Bearer auth on /api/*', async () => {
    const app = createTaskimaticApp();

    const health = await app.fetch(new Request('https://taskimatic.dev/health'));
    expect(health.status).toBe(200);
    expect(health.headers.get('X-Powered-By')).toBe('endGO');
    expect(health.headers.get('X-Response-Time')).toMatch(/ms$/);
    expect(await health.json()).toEqual({ status: 'ok', service: 'taskimatic' });

    const noAuth = await app.fetch(new Request('https://taskimatic.dev/api/tasks'));
    expect(noAuth.status).toBe(401);

    const badAuth = await app.fetch(
      new Request('https://taskimatic.dev/api/tasks', {
        headers: { Authorization: 'Bearer wrong-token' },
      })
    );
    expect(badAuth.status).toBe(401);
  });

  test('performs full CRUD lifecycle, lazy device inspection, waitUntil, and 405 handling', async () => {
    const app = createTaskimaticApp();
    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx: ExecutionContext = {
      waitUntil: (p) => waitUntilPromises.push(p),
    };
    const workerEnv: Partial<TaskimaticEnv> = {
      TASK_NAMESPACE: createInMemoryTaskNamespace(),
      API_SECRET: 'worker-secret-123',
    };
    const headers = {
      Authorization: 'Bearer worker-secret-123',
      'x-tenant-id': 'mentic',
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    };

    // POST /api/tasks
    const createRes = await app.fetch(
      new Request('https://taskimatic.dev/api/tasks', {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Verify endGO MVP' }),
      }),
      workerEnv,
      ctx
    );
    expect(createRes.status).toBe(201);
    const createdBody = (await createRes.json()) as { task: TaskRecord };
    expect(createdBody.task.title).toBe('Verify endGO MVP');
    expect(createdBody.task.completed).toBe(false);
    expect(createdBody.task.tenantId).toBe('mentic');
    expect(createdBody.task.createdFromMobile).toBe(true);
    expect(waitUntilPromises.length).toBe(1);
    await Promise.all(waitUntilPromises);

    const taskId = createdBody.task.id;

    // GET /api/tasks
    const listRes = await app.fetch(
      new Request('https://taskimatic.dev/api/tasks', { headers }),
      workerEnv,
      ctx
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      tenantId: string;
      tasks: TaskRecord[];
    };
    expect(listBody.tenantId).toBe('mentic');
    expect(listBody.tasks.length).toBe(1);
    expect(listBody.tasks[0].id).toBe(taskId);

    // GET /api/tasks/:id
    const getRes = await app.fetch(
      new Request(`https://taskimatic.dev/api/tasks/${taskId}`, { headers }),
      workerEnv,
      ctx
    );
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as { task: TaskRecord }).task.id).toBe(taskId);

    // PATCH /api/tasks/:id
    const patchRes = await app.fetch(
      new Request(`https://taskimatic.dev/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ completed: true, title: 'Ship endGO MVP' }),
      }),
      workerEnv,
      ctx
    );
    expect(patchRes.status).toBe(200);
    const patchedBody = (await patchRes.json()) as { task: TaskRecord };
    expect(patchedBody.task.completed).toBe(true);
    expect(patchedBody.task.title).toBe('Ship endGO MVP');

    // 405 on unsupported verb PUT /api/tasks
    const putRes = await app.fetch(
      new Request('https://taskimatic.dev/api/tasks', {
        method: 'PUT',
        headers,
      }),
      workerEnv,
      ctx
    );
    expect(putRes.status).toBe(405);
    expect(putRes.headers.get('Allow')).toBe('GET, POST, HEAD');

    // DELETE /api/tasks/:id
    const deleteRes = await app.fetch(
      new Request(`https://taskimatic.dev/api/tasks/${taskId}`, {
        method: 'DELETE',
        headers,
      }),
      workerEnv,
      ctx
    );
    expect(deleteRes.status).toBe(204);
    expect(deleteRes.body).toBeNull();

    // Confirm deleted task returns 404
    const afterDelete = await app.fetch(
      new Request(`https://taskimatic.dev/api/tasks/${taskId}`, { headers }),
      workerEnv,
      ctx
    );
    expect(afterDelete.status).toBe(404);
  });

  test('uses default Environment when no workerEnv is provided', async () => {
    const app = createTaskimaticApp();
    const res = await app.fetch(
      new Request('https://taskimatic.dev/api/tasks', {
        headers: AUTH_HEADERS,
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: 'acme', tasks: [] });
  });
});
