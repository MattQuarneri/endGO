/**
 * taskimatic Worker Example
 * Demonstrates how to build a simple To-Do API worker using the endGO framework.
 */


import { endGO, type ExecutionContext } from '../src/index.js';

export interface TaskRecord {
  id: string;
  title: string;
  completed: boolean;
  tenantId: string;
  ownerId: string;
  createdFromMobile: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export type TaskimaticEnv = {
  TASK_NAMESPACE: TaskNamespace;
  API_SECRET: string;
};

interface TaskUser {
  id: string;
  name: string;
}

interface TaskTenant {
  id: string;
  plan: string;
}

/**
 * Creates a simple in-memory KV-like namespace compatible with {@link TaskNamespace}.
 */
export function createInMemoryTaskNamespace(): TaskNamespace {
  const store = new Map<string, string>();

  return {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(prefix = ''): Promise<string[]> {
      const keys: string[] = [];
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          keys.push(key);
        }
      }
      return keys;
    },
  };
}

function taskKey(tenantId: string, id: string): string {
  return `tenant:${tenantId}:task:${id}`;
}

function cloneWithHeaders(
  response: Response,
  extraHeaders: Record<string, string>
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function scheduleAuditLog(
  ctx: ExecutionContext | undefined,
  logFn: () => void
): void {
  const work = Promise.resolve().then(logFn);
  ctx?.waitUntil(work);
}

/**
 * Builds the Taskimatic API application powered by endGO.
 */
export function createTaskimaticApp(): endGO<TaskimaticEnv> {
  const app = new endGO<TaskimaticEnv>({
    Environment: {
      TASK_NAMESPACE: createInMemoryTaskNamespace(),
      API_SECRET: 'taskimatic-dev-secret',
    },
  });

  // Global middleware: timing, framework header, and structured error boundary
  app.mid('*', async ({ request, server }, next) => {
    const start = performance.now();
    try {
      const response = await next();
      const durationMs = (performance.now() - start).toFixed(2);
      return cloneWithHeaders(response, {
        'X-Response-Time': `${durationMs}ms`,
        'X-Powered-By': 'endGO',
      });
    } catch (error) {
      server.logger.error('Taskimatic unhandled error', {
        method: request.resolved.method,
        path: request.resolved.url.pathname,
        error,
      });
      return server.reply(500, { error: 'Internal Server Error' });
    }
  });

  // Scoped middleware: Bearer authentication and immutable Requestor tenant hydration
  app.mid('/api/*', async (context, next) => {
    const authHeader = context.request.resolved.headers.get('authorization');
    const expectedSecret = context.server.env.API_SECRET;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return context.server.reply(401, { error: 'Missing Bearer token' });
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token || token !== expectedSecret) {
      return context.server.reply(401, { error: 'Invalid Bearer token' });
    }

    const tenantId =
      context.request.resolved.headers.get('x-tenant-id')?.trim() || 'default';
    const user: TaskUser = {
      id: context.request.resolved.headers.get('x-user-id')?.trim() || 'usr_1',
      name: 'Taskimatic Operator',
    };
    const tenant: TaskTenant = {
      id: tenantId,
      plan: 'pro',
    };

    context.requestor = Object.freeze({
      ...context.requestor,
      user,
      tenant,
      token,
      roles: Object.freeze(['member', 'editor']),
      authProvider: 'bearer',
    });

    return next();
  });

  // Public health check
  app.end('/health', ({ server }) =>
    server.reply(200, { status: 'ok', service: 'taskimatic' })
  );

  // Task collection endpoints
  app.end('/api/tasks', {
    GET: async ({ requestor, server }) => {
      const tenant = requestor.tenant as TaskTenant;
      const prefix = `tenant:${tenant.id}:task:`;
      const keys = await server.env.TASK_NAMESPACE.list(prefix);
      const tasks: TaskRecord[] = [];

      for (const key of keys) {
        const raw = await server.env.TASK_NAMESPACE.get(key);
        if (raw) {
          tasks.push(JSON.parse(raw) as TaskRecord);
        }
      }

      return server.reply(200, {
        tenantId: tenant.id,
        tasks,
      });
    },

    POST: async ({ request, requestor, server }) => {
      if (!request.resolved.body) {
        return server.reply(400, { error: 'Request body is required' });
      }

      const tenant = requestor.tenant as TaskTenant;
      const user = requestor.user as TaskUser;

      let payload: { title?: unknown; completed?: unknown } | null = null;
      try {
        payload = await request.resolved.body.json<
          { title?: unknown; completed?: unknown } | null,
          { title?: unknown; completed?: unknown } | null
        >((data) => data);
      } catch {
        return server.reply(400, { error: 'Invalid JSON payload' });
      }

      const title =
        typeof payload?.title === 'string' ? payload.title.trim() : '';
      if (!title) {
        return server.reply(400, { error: 'Task title is required' });
      }

      const now = new Date().toISOString();
      const task: TaskRecord = {
        id: crypto.randomUUID(),
        title,
        completed: Boolean(payload?.completed),
        tenantId: tenant.id,
        ownerId: user.id,
        // Lazy UA parsing happens only when requestor.device.isMobile is accessed
        createdFromMobile: Boolean(requestor.device.isMobile),
        createdAt: now,
        updatedAt: now,
      };

      await server.env.TASK_NAMESPACE.put(
        taskKey(tenant.id, task.id),
        JSON.stringify(task)
      );

      scheduleAuditLog(server.ctx, () => {
        server.logger.info('task.created', {
          taskId: task.id,
          tenantId: tenant.id,
        });
      });

      return server.reply(201, { task });
    },
  });

  // Single task endpoints
  app.end('/api/tasks/:id', {
    GET: async ({ request, requestor, server }) => {
      const tenant = requestor.tenant as TaskTenant;
      const raw = await server.env.TASK_NAMESPACE.get(
        taskKey(tenant.id, request.resolved.params.id)
      );

      if (!raw) {
        return server.reply(404, { error: 'Task not found' });
      }

      return server.reply(200, { task: JSON.parse(raw) as TaskRecord });
    },

    PATCH: async ({ request, requestor, server }) => {
      const tenant = requestor.tenant as TaskTenant;
      const key = taskKey(tenant.id, request.resolved.params.id);
      const existingRaw = await server.env.TASK_NAMESPACE.get(key);

      if (!existingRaw) {
        return server.reply(404, { error: 'Task not found' });
      }

      if (!request.resolved.body) {
        return server.reply(400, { error: 'Request body is required' });
      }

      const existing = JSON.parse(existingRaw) as TaskRecord;

      const updated = await request.resolved.body.json<
        { title?: unknown; completed?: unknown } | null,
        TaskRecord | null
      >((data) => {
        if (!data || typeof data !== 'object') {
          return null;
        }

        const nextTitle =
          typeof data.title === 'string' && data.title.trim()
            ? data.title.trim()
            : existing.title;
        const nextCompleted =
          typeof data.completed === 'boolean'
            ? data.completed
            : existing.completed;

        return {
          ...existing,
          title: nextTitle,
          completed: nextCompleted,
          updatedAt: new Date().toISOString(),
        };
      });

      if (!updated) {
        return server.reply(400, { error: 'Invalid update payload' });
      }

      await server.env.TASK_NAMESPACE.put(key, JSON.stringify(updated));
      return server.reply(200, { task: updated });
    },

    DELETE: async ({ request, requestor, server }) => {
      const tenant = requestor.tenant as TaskTenant;
      const key = taskKey(tenant.id, request.resolved.params.id);
      const existingRaw = await server.env.TASK_NAMESPACE.get(key);

      if (!existingRaw) {
        return server.reply(404, { error: 'Task not found' });
      }

      await server.env.TASK_NAMESPACE.delete(key);
      return server.reply(204);
    },
  });

  return app;
}

export default createTaskimaticApp();
