import { describe, expect, it } from 'bun:test';
import {
  bearerAuth,
  bodyLimit,
  cors,
  getRequestId,
  getValidated,
  requestId,
  requestLogger,
  requireAuth,
  requirePermission,
  requireRole,
  secureHeaders,
  validate,
  type StandardSchemaV1,
} from '../src/builtins/index.js';
import { endGO } from '../src/endGO.js';
import type { endGOLogger, Requestor } from '../src/types.js';

function createMockSchema<TOutput>(
  fn: (
    value: unknown
  ) =>
    | StandardSchemaV1.Result<TOutput>
    | Promise<StandardSchemaV1.Result<TOutput>>
): StandardSchemaV1<unknown, TOutput> {
  return {
    '~standard': {
      version: 1,
      vendor: 'mock-schema',
      validate: fn,
    },
  };
}

function createSilentLogger(): {
  logger: endGOLogger;
  infoCalls: Array<{ msg: string; meta: unknown[] }>;
} {
  const infoCalls: Array<{ msg: string; meta: unknown[] }> = [];
  const logger: endGOLogger = {
    info: (msg: string, ...meta: unknown[]) => {
      infoCalls.push({ msg, meta });
    },
    error: () => {},
    warn: () => {},
    debug: () => {},
  };
  return { logger, infoCalls };
}

describe('builtins/validate', () => {
  it('validates json, query, params, and headers with Standard Schema v1 and shares memoized body read', async () => {
    const app = new endGO();

    const schemas = {
      params: createMockSchema<{ id: string }>((val) => {
        const obj = val as Record<string, string>;
        if (!obj?.id || obj.id.length < 2) {
          return { issues: [{ message: 'Invalid id', path: ['id'] }] };
        }
        return { value: { id: obj.id } };
      }),
      query: createMockSchema<{ page: number }>((val) => {
        const obj = val as Record<string, string>;
        const page = Number(obj?.page ?? '1');
        if (!Number.isInteger(page) || page < 1) {
          return { issues: [{ message: 'Invalid page', path: ['page'] }] };
        }
        return { value: { page } };
      }),
      headers: createMockSchema<{ 'x-api-key': string }>((val) => {
        const obj = val as Record<string, string>;
        if (!obj?.['x-api-key']) {
          return { issues: [{ message: 'Missing x-api-key', path: ['x-api-key'] }] };
        }
        return { value: { 'x-api-key': obj['x-api-key'] } };
      }),
      json: createMockSchema<{ title: string; count: number }>(async (val) => {
        const obj = val as Record<string, unknown>;
        if (!obj || typeof obj.title !== 'string') {
          return { issues: [{ message: 'title must be a string', path: ['title'] }] };
        }
        return {
          value: {
            title: obj.title.trim(),
            count: typeof obj.count === 'number' ? obj.count : 0,
          },
        };
      }),
    };

    app.mid('/items/:id', validate(schemas));
    app.end('/items/:id', {
      POST: async ({ request, server }) => {
        const validated = getValidated<typeof schemas>(request);
        const rawBody = await request.resolved.body?.json<{ title: string }>();
        return server.reply(200, {
          validated,
          rawTitle: rawBody?.title,
        });
      },
    });

    const res = await app.fetch(
      new Request('https://example.com/items/42?page=3', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'secret-key',
        },
        body: JSON.stringify({ title: '  Widget  ', count: 5 }),
      })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      validated: {
        params: { id: string };
        query: { page: number };
        headers: { 'x-api-key': string };
        json: { title: string; count: number };
      };
      rawTitle: string;
    };
    expect(body.validated).toEqual({
      params: { id: '42' },
      query: { page: 3 },
      headers: { 'x-api-key': 'secret-key' },
      json: { title: 'Widget', count: 5 },
    });
    expect(body.rawTitle).toBe('  Widget  ');
  });

  it('returns 400 structured validation error on failure and supports onValidationError', async () => {
    const app = new endGO();
    const jsonSchema = createMockSchema<{ name: string }>((val) => {
      const obj = val as Record<string, unknown>;
      if (!obj || typeof obj.name !== 'string') {
        return { issues: [{ message: 'name is required', path: ['name'] }] };
      }
      return { value: { name: obj.name } };
    });

    app.mid('/users', validate({ json: jsonSchema }));
    app.end('/users', {
      POST: ({ server }) => server.reply(201, { ok: true }),
    });

    const badRes = await app.fetch(
      new Request('https://example.com/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 123 }),
      })
    );

    expect(badRes.status).toBe(400);
    const errPayload = (await badRes.json()) as {
      error: string;
      target: string;
      issues: Array<{ message: string; path?: string[] }>;
    };
    expect(errPayload.error).toBe('Validation Failed');
    expect(errPayload.target).toBe('json');
    expect(errPayload.issues).toEqual([{ message: 'name is required', path: ['name'] }]);

    const malformedRes = await app.fetch(
      new Request('https://example.com/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{invalid-json',
      })
    );
    expect(malformedRes.status).toBe(400);
    const malformedPayload = (await malformedRes.json()) as { target: string };
    expect(malformedPayload.target).toBe('json');

    const customApp = new endGO();
    customApp.mid(
      '/custom',
      validate(
        { json: jsonSchema },
        {
          onValidationError: (err, ctx) =>
            ctx.server.reply(422, { custom: true, target: err.target }),
        }
      )
    );
    customApp.end('/custom', {
      POST: ({ server }) => server.reply(200, { ok: true }),
    });

    const customRes = await customApp.fetch(
      new Request('https://example.com/custom', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(customRes.status).toBe(422);
    expect(await customRes.json()).toEqual({ custom: true, target: 'json' });
  });
});

describe('builtins/cors', () => {
  it('handles OPTIONS preflight with 204 and applies CORS headers to responses', async () => {
    const app = new endGO();
    app.mid(
      cors({
        origin: ['https://app.example.com', 'https://admin.example.com'],
        methods: ['GET', 'POST'],
        allowHeaders: ['Authorization', 'Content-Type'],
        exposeHeaders: ['X-Total-Count'],
        credentials: true,
        maxAge: 600,
      })
    );
    app.end('/data', {
      GET: ({ server }) => server.reply(200, { ok: true }),
    });

    const preflight = await app.fetch(
      new Request('https://api.example.com/data', {
        method: 'OPTIONS',
        headers: { origin: 'https://app.example.com' },
      })
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://app.example.com'
    );
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST');
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toBe(
      'Authorization, Content-Type'
    );
    expect(preflight.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(preflight.headers.get('Access-Control-Max-Age')).toBe('600');
    expect(preflight.headers.get('Vary')).toContain('Origin');

    const actual = await app.fetch(
      new Request('https://api.example.com/data', {
        method: 'GET',
        headers: { origin: 'https://app.example.com' },
      })
    );
    expect(actual.status).toBe(200);
    expect(actual.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://app.example.com'
    );
    expect(actual.headers.get('Access-Control-Expose-Headers')).toBe('X-Total-Count');

    const disallowed = await app.fetch(
      new Request('https://api.example.com/data', {
        method: 'GET',
        headers: { origin: 'https://evil.example.com' },
      })
    );
    expect(disallowed.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('supports dynamic origin resolver function', async () => {
    const app = new endGO();
    app.mid(
      cors({
        origin: (origin) => (origin.endsWith('.trusted.dev') ? origin : false),
      })
    );
    app.end('/ping', ({ server }) => server.reply(200, 'pong'));

    const allowed = await app.fetch(
      new Request('https://api.example.com/ping', {
        headers: { origin: 'https://sub.trusted.dev' },
      })
    );
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://sub.trusted.dev'
    );

    const denied = await app.fetch(
      new Request('https://api.example.com/ping', {
        headers: { origin: 'https://untrusted.dev' },
      })
    );
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('builtins/security', () => {
  it('secureHeaders sets default security headers and supports overrides/opt-outs', async () => {
    const app = new endGO();
    app.mid(
      secureHeaders({
        xFrameOptions: 'DENY',
        xXssProtection: false,
        contentSecurityPolicy: "default-src 'self'",
      })
    );
    app.end('/secure', ({ server }) => server.reply(200, { ok: true }));

    const res = await app.fetch(new Request('https://example.com/secure'));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-XSS-Protection')).toBeNull();
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'self'");
  });

  it('bodyLimit enforces Content-Length and streamed byte count without breaking downstream body reads', async () => {
    const app = new endGO();
    app.mid('/upload', bodyLimit({ maxBytes: 20 }));
    app.end('/upload', {
      POST: async ({ request, server }) => {
        const data = await request.resolved.body?.json();
        return server.reply(200, { received: data });
      },
    });

    const okRes = await app.fetch(
      new Request('https://example.com/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ a: 1 }),
      })
    );
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ received: { a: 1 } });

    const headerTooLarge = await app.fetch(
      new Request('https://example.com/upload', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '100',
        },
        body: JSON.stringify({ a: 1 }),
      })
    );
    expect(headerTooLarge.status).toBe(413);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"msg":"0123456789'));
        controller.enqueue(new TextEncoder().encode('0123456789"}'));
        controller.close();
      },
    });
    const streamTooLarge = await app.fetch(
      new Request('https://example.com/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stream,
      })
    );
    expect(streamTooLarge.status).toBe(413);
  });
});

describe('builtins/observability', () => {
  it('requestId reads or generates X-Request-Id and requestLogger logs method, path, status, duration', async () => {
    const { logger, infoCalls } = createSilentLogger();
    const app = new endGO({ logger });

    app.mid(requestId());
    app.mid(requestLogger());
    app.end('/hello', ({ request, server }) => {
      return server.reply(200, { id: getRequestId(request) });
    });

    const generatedRes = await app.fetch(new Request('https://example.com/hello'));
    expect(generatedRes.status).toBe(200);
    const generatedId = generatedRes.headers.get('X-Request-Id');
    expect(generatedId).toBeTruthy();
    expect(generatedId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(await generatedRes.json()).toEqual({ id: generatedId });

    const echoedRes = await app.fetch(
      new Request('https://example.com/hello', {
        headers: { 'X-Request-Id': 'req-custom-123' },
      })
    );
    expect(echoedRes.headers.get('X-Request-Id')).toBe('req-custom-123');
    expect(await echoedRes.json()).toEqual({ id: 'req-custom-123' });

    expect(infoCalls.length).toBe(2);
    expect(infoCalls[0].msg).toContain('GET /hello 200');
    const meta = infoCalls[0].meta[0] as {
      method: string;
      path: string;
      status: number;
      durationMs: number;
    };
    expect(meta.method).toBe('GET');
    expect(meta.path).toBe('/hello');
    expect(meta.status).toBe(200);
    expect(typeof meta.durationMs).toBe('number');
  });
});

describe('builtins/auth', () => {
  it('bearerAuth swaps requestor with a new frozen snapshot and preserves immutability', async () => {
    const app = new endGO();
    let seenInitialRequestor: Requestor | null = null;

    app.mid('/api/*', async (ctx, next) => {
      seenInitialRequestor = ctx.requestor;
      return next();
    });

    app.mid(
      '/api/*',
      bearerAuth({
        realm: 'endgo-api',
        verify: async (token) => {
          if (token !== 'valid-token') return null;
          return {
            user: { id: 'usr_1', email: 'alice@example.com' },
            tenant: { id: 'ten_1' },
            session: { id: 'ses_1' },
            roles: ['editor'],
            permissions: ['tasks:read', 'tasks:write'],
            authProvider: 'jwt',
          };
        },
      })
    );

    app.end('/api/me', ({ requestor, server }) => {
      return server.reply(200, {
        user: requestor.user,
        tenant: requestor.tenant,
        roles: requestor.roles,
        permissions: requestor.permissions,
        authProvider: requestor.authProvider,
        isFrozen: Object.isFrozen(requestor),
        rolesFrozen: Object.isFrozen(requestor.roles),
        permsFrozen: Object.isFrozen(requestor.permissions),
      });
    });

    const missingRes = await app.fetch(new Request('https://example.com/api/me'));
    expect(missingRes.status).toBe(401);
    expect(missingRes.headers.get('WWW-Authenticate')).toBe('Bearer realm="endgo-api"');

    const badRes = await app.fetch(
      new Request('https://example.com/api/me', {
        headers: { Authorization: 'Bearer wrong-token' },
      })
    );
    expect(badRes.status).toBe(401);

    const okRes = await app.fetch(
      new Request('https://example.com/api/me', {
        headers: {
          Authorization: 'Bearer valid-token',
          'Accept-Language': 'fr-FR',
        },
      })
    );
    expect(okRes.status).toBe(200);
    const body = (await okRes.json()) as {
      user: { id: string; email: string };
      tenant: { id: string };
      roles: string[];
      permissions: string[];
      authProvider: string;
      isFrozen: boolean;
      rolesFrozen: boolean;
      permsFrozen: boolean;
    };
    expect(body.user).toEqual({ id: 'usr_1', email: 'alice@example.com' });
    expect(body.tenant).toEqual({ id: 'ten_1' });
    expect(body.roles).toEqual(['editor']);
    expect(body.permissions).toEqual(['tasks:read', 'tasks:write']);
    expect(body.authProvider).toBe('jwt');
    expect(body.isFrozen).toBe(true);
    expect(body.rolesFrozen).toBe(true);
    expect(body.permsFrozen).toBe(true);

    // Original initial requestor snapshot remains unmutated and frozen
    expect(seenInitialRequestor).not.toBeNull();
    expect(seenInitialRequestor!.user).toBeNull();
    expect(Object.isFrozen(seenInitialRequestor)).toBe(true);
  });

  it('requireAuth, requireRole, and requirePermission enforce 401/403 authorization', async () => {
    const app = new endGO();

    app.mid('/protected/*', async (ctx, next) => {
      const roleHeader = ctx.request.resolved.headers.get('x-test-role');
      const permHeader = ctx.request.resolved.headers.get('x-test-perms');
      if (roleHeader || permHeader) {
        ctx.requestor = Object.freeze({
          ...ctx.requestor,
          user: { id: 'u1' },
          roles: Object.freeze(roleHeader ? roleHeader.split(',') : []),
          permissions: Object.freeze(permHeader ? permHeader.split(',') : []),
        });
      }
      return next();
    });

    app.mid('/protected/auth-only', requireAuth());
    app.end('/protected/auth-only', ({ server }) => server.reply(200, { ok: true }));

    app.mid('/protected/admin', requireAuth(), requireRole('admin', 'superadmin'));
    app.end('/protected/admin', ({ server }) => server.reply(200, { admin: true }));

    app.mid(
      '/protected/billing',
      requireAuth(),
      requirePermission('billing:read', 'billing:write')
    );
    app.end('/protected/billing', ({ server }) => server.reply(200, { billing: true }));

    const unauth = await app.fetch(
      new Request('https://example.com/protected/auth-only')
    );
    expect(unauth.status).toBe(401);

    const wrongRole = await app.fetch(
      new Request('https://example.com/protected/admin', {
        headers: { 'x-test-role': 'viewer' },
      })
    );
    expect(wrongRole.status).toBe(403);

    const rightRole = await app.fetch(
      new Request('https://example.com/protected/admin', {
        headers: { 'x-test-role': 'admin' },
      })
    );
    expect(rightRole.status).toBe(200);

    const partialPerms = await app.fetch(
      new Request('https://example.com/protected/billing', {
        headers: { 'x-test-perms': 'billing:read' },
      })
    );
    expect(partialPerms.status).toBe(403);

    const fullPerms = await app.fetch(
      new Request('https://example.com/protected/billing', {
        headers: { 'x-test-perms': 'billing:read,billing:write' },
      })
    );
    expect(fullPerms.status).toBe(200);
  });
});
