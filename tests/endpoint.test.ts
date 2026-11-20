import { describe, expect, test } from 'bun:test';
import {
  defineEndpoint,
  endGO,
  type endGOLogger,
} from '../src/index.js';

const silentLogger: endGOLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

describe('defineEndpoint & app.register', () => {
  test('mounts eager actions with scoped middleware and 405 handling', async () => {
    const app = new endGO({ logger: silentLogger });
    const trace: string[] = [];

    const itemEndpoint = defineEndpoint({
      id: 'items.detail',
      path: '/items/:id',
      middleware: [
        async (ctx, next) => {
          trace.push(`mw:${ctx.request.resolved.params.id}`);
          const res = await next();
          res.headers.set('X-Endpoint-Id', 'items.detail');
          return res;
        },
      ],
      actions: {
        GET: ({ request, server }) =>
          server.reply(200, { id: request.resolved.params.id }),
      },
    });

    app.register(itemEndpoint);

    const getRes = await app.fetch(new Request('https://example.com/items/abc'));
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('X-Endpoint-Id')).toBe('items.detail');
    expect(await getRes.json()).toEqual({ id: 'abc' });
    expect(trace).toEqual(['mw:abc']);

    const delRes = await app.fetch(
      new Request('https://example.com/items/abc', { method: 'DELETE' })
    );
    expect(delRes.status).toBe(405);
    expect(delRes.headers.get('Allow')).toBe('GET, HEAD');
  });

  test('deduplicates concurrent lazy loads and caches resolved implementation', async () => {
    const app = new endGO({ logger: silentLogger });
    let loadCount = 0;

    const lazyEndpoint = defineEndpoint({
      id: 'reports.lazy',
      path: '/reports/:reportId',
      load: async () => {
        loadCount++;
        await new Promise((r) => setTimeout(r, 15));
        return {
          default: {
            GET: ({ request, server }) =>
              server.reply(200, {
                reportId: request.resolved.params.reportId,
                loadCount,
              }),
          },
        };
      },
    });

    app.register(lazyEndpoint);

    const [res1, res2, res3] = await Promise.all([
      app.fetch(new Request('https://example.com/reports/r1')),
      app.fetch(new Request('https://example.com/reports/r2')),
      app.fetch(new Request('https://example.com/reports/r3')),
    ]);

    expect(loadCount).toBe(1);
    expect(await res1.json()).toEqual({ reportId: 'r1', loadCount: 1 });
    expect(await res2.json()).toEqual({ reportId: 'r2', loadCount: 1 });
    expect(await res3.json()).toEqual({ reportId: 'r3', loadCount: 1 });

    // Subsequent call uses cached implementation
    const res4 = await app.fetch(new Request('https://example.com/reports/r4'));
    expect(loadCount).toBe(1);
    expect(await res4.json()).toEqual({ reportId: 'r4', loadCount: 1 });

    // Unsupported method on lazy endpoint returns 405 with Allow header
    const postRes = await app.fetch(
      new Request('https://example.com/reports/r4', { method: 'POST' })
    );
    expect(postRes.status).toBe(405);
    expect(postRes.headers.get('Allow')).toBe('GET, HEAD');
  });

  test('retries lazy load after a failed load', async () => {
    const app = new endGO({ logger: silentLogger });
    let attempts = 0;

    const flakyLoadEndpoint = defineEndpoint({
      id: 'flaky.load',
      path: '/flaky-load',
      load: async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('transient import failure');
        }
        return {
          GET: ({ server }) => server.reply(200, { recovered: true, attempts }),
        };
      },
    });

    app.register(flakyLoadEndpoint);

    const first = await app.fetch(new Request('https://example.com/flaky-load'));
    expect(first.status).toBe(500);
    expect(attempts).toBe(1);

    const second = await app.fetch(new Request('https://example.com/flaky-load'));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ recovered: true, attempts: 2 });
  });

  test('supports versioned canary selection and manual rollback', async () => {
    const app = new endGO({ logger: silentLogger });

    const versioned = defineEndpoint({
      id: 'search.query',
      path: '/search',
      selectVersion: (ctx) =>
        ctx.request.resolved.headers.get('x-canary') === '1' ? 'v2' : 'v1',
      versions: {
        v1: {
          GET: ({ server }) => server.reply(200, { version: 'v1' }),
        },
        v2: {
          load: async () => ({
            GET: ({ server }) => server.reply(200, { version: 'v2-canary' }),
          }),
        },
      },
    });

    app.register(versioned);

    const stableRes = await app.fetch(new Request('https://example.com/search'));
    expect(stableRes.status).toBe(200);
    expect(await stableRes.json()).toEqual({ version: 'v1' });

    const canaryRes = await app.fetch(
      new Request('https://example.com/search', {
        headers: { 'x-canary': '1' },
      })
    );
    expect(canaryRes.status).toBe(200);
    expect(await canaryRes.json()).toEqual({ version: 'v2-canary' });
  });

  test('serves fallback on safe reads (GET/HEAD) when primary throws or times out, but not on POST', async () => {
    const app = new endGO({ logger: silentLogger });

    const resilientEndpoint = defineEndpoint({
      id: 'catalog.item',
      path: '/catalog',
      timeoutMs: 20,
      selectVersion: (ctx) =>
        ctx.request.resolved.headers.get('x-mode') ?? 'throw',
      versions: {
        throw: {
          GET: () => {
            throw new Error('canary exploded');
          },
          POST: () => {
            throw new Error('mutation exploded');
          },
        },
        slow: {
          GET: async ({ server }) => {
            await new Promise((r) => setTimeout(r, 60));
            return server.reply(200, { slow: true });
          },
        },
      },
      fallback: {
        GET: ({ server }) => server.reply(200, { fallback: true }),
        POST: ({ server }) => server.reply(200, { shouldNeverRun: true }),
      },
    });

    app.register(resilientEndpoint);

    // GET throws -> fallback
    const getThrowRes = await app.fetch(new Request('https://example.com/catalog'));
    expect(getThrowRes.status).toBe(200);
    expect(await getThrowRes.json()).toEqual({ fallback: true });

    // HEAD throws -> fallback (body stripped by app.fetch)
    const headThrowRes = await app.fetch(
      new Request('https://example.com/catalog', { method: 'HEAD' })
    );
    expect(headThrowRes.status).toBe(200);
    expect(headThrowRes.body).toBeNull();

    // GET times out -> fallback
    const slowRes = await app.fetch(
      new Request('https://example.com/catalog', {
        headers: { 'x-mode': 'slow' },
      })
    );
    expect(slowRes.status).toBe(200);
    expect(await slowRes.json()).toEqual({ fallback: true });

    // POST throws -> does NOT fall back, returns 500
    const postRes = await app.fetch(
      new Request('https://example.com/catalog', { method: 'POST' })
    );
    expect(postRes.status).toBe(500);
  });
});
