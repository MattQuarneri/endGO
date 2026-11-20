import {
  defineEndpoint,
  endGO,
  type ExecutionContext,
  type HandlerContext,
} from 'endgo';
import {
  bearerAuth,
  cors,
  getValidated,
  requestId,
  validate,
  type StandardSchemaV1,
} from 'endgo/middleware';

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<Row = Record<string, unknown>>(column?: string): Promise<Row | null>;
  run<Row = Record<string, unknown>>(): Promise<{ success?: boolean; meta?: { changes?: number } }>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
}

export interface FetcherLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface Env {
  [key: string]: unknown;
  DB: D1DatabaseLike;
  ENDGO_API_TOKEN?: string;
  REPORTS_SERVICE?: FetcherLike;
}

type ReportContext = HandlerContext<Env, { id: string }>;

interface ItemRow {
  id: string;
  title: string;
  updated_at: string;
}

const itemInputSchema: StandardSchemaV1<{ title: string }, { title: string }> = {
  '~standard': {
    version: 1,
    vendor: 'endgo-starter',
    validate(value: unknown) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'Expected a JSON object', path: [] }] };
      }
      const rawTitle = (value as { title?: unknown }).title;
      if (typeof rawTitle !== 'string' || rawTitle.trim().length === 0) {
        return {
          issues: [{ message: 'title must be a non-empty string', path: ['title'] }],
        };
      }
      return { value: { title: rawTitle.trim() } };
    },
  },
};

const validateItemPut = validate({ json: itemInputSchema });

const reportsEndpoint = defineEndpoint<'/api/reports/:id', Env>({
  id: 'reports.detail',
  path: '/api/reports/:id',
  middleware: [
    async ({ request, server }, next) => {
      if (server.env.REPORTS_SERVICE) {
        return server.env.REPORTS_SERVICE.fetch(request.raw);
      }
      return next();
    },
  ],
  selectVersion: ({ request }) =>
    request.resolved.headers.get('x-canary-cohort') === 'v2' ? 'v2' : 'v1',
  versions: {
    v1: {
      load: async () => ({
        GET: ({ request, server }: ReportContext) =>
          server.reply(200, {
            id: request.resolved.params.id,
            version: 'v1',
            source: 'primary',
          }),
        POST: async ({ request, server }: ReportContext) => {
          if (request.resolved.query.fail === '1') {
            throw new Error('v1 report write failure');
          }
          return server.reply(201, {
            id: request.resolved.params.id,
            version: 'v1',
            created: true,
          });
        },
      }),
    },
    v2: {
      load: async () => ({
        GET: ({ request, server }: ReportContext) => {
          if (request.resolved.query.fail === '1') {
            throw new Error('v2 canary report read failure');
          }
          return server.reply(200, {
            id: request.resolved.params.id,
            version: 'v2',
            source: 'canary',
          });
        },
        POST: async ({ request, server }: ReportContext) => {
          if (request.resolved.query.fail === '1') {
            throw new Error('v2 canary report write failure');
          }
          return server.reply(201, {
            id: request.resolved.params.id,
            version: 'v2',
            created: true,
          });
        },
      }),
    },
  },
  fallback: {
    GET: ({ request, server }) =>
      server.reply(200, {
        id: request.resolved.params.id,
        version: 'v1',
        source: 'fallback',
      }),
  },
});

export function createWorkerApp() {
  const app = new endGO<Env>();

  app.mid(requestId());
  app.mid(cors());

  app.end('/health', {
    GET: async ({ server }) => {
      const row = await server.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
      return server.reply(200, {
        ok: row?.ok === 1,
        database: row?.ok === 1,
      });
    },
  });

  app.mid(
    '/api/*',
    bearerAuth({
      verify: (token, context) => {
        const expected = (context.server.env as Env).ENDGO_API_TOKEN;
        if (!expected || token !== expected) {
          return null;
        }
        return { user: { id: 'api-client' }, roles: ['api'] };
      },
    })
  );

  app.mid('/api/items/:id', async (context, next) => {
    if (context.request.resolved.method === 'PUT') {
      return validateItemPut(context, next);
    }
    return next();
  });

  app.end('/api/items/:id', {
    GET: async ({ request, server }) => {
      const row = await server.env.DB.prepare(
        'SELECT id, title, updated_at FROM items WHERE id = ?'
      )
        .bind(request.resolved.params.id)
        .first<ItemRow>();

      if (!row) {
        return server.reply(404, { error: 'Item not found' });
      }
      return server.reply(200, row);
    },
    PUT: async ({ request, server }) => {
      const { json } = getValidated<{ json: typeof itemInputSchema }>(request);
      const id = request.resolved.params.id;
      const updatedAt = new Date().toISOString();

      await server.env.DB.prepare(
        `INSERT INTO items (id, title, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`
      )
        .bind(id, json.title, updatedAt)
        .run();

      return server.reply(200, {
        id,
        title: json.title,
        updated_at: updatedAt,
      });
    },
  });

  app.register(reportsEndpoint);

  return app;
}

const app = createWorkerApp();

export default {
  fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};
