import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '../..');
const starterDir = resolve(rootDir, 'examples/worker-starter');
const TOKEN = 'local-dev-token';

async function bundleStarterWorker() {
  const result = await esbuild.build({
    entryPoints: [resolve(starterDir, 'src/worker.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    alias: {
      endgo: resolve(rootDir, 'dist/index.js'),
      'endgo/middleware': resolve(rootDir, 'dist/builtins/index.js'),
    },
  });

  if (result.outputFiles.length === 0) {
    throw new Error('esbuild produced no output for worker-starter');
  }
  return result.outputFiles[0].text;
}

describe('worker-starter in workerd (Miniflare)', () => {
  let bundledCode;
  let schemaSql;
  let mf;

  before(async () => {
    [bundledCode, schemaSql] = await Promise.all([
      bundleStarterWorker(),
      readFile(resolve(starterDir, 'schema.sql'), 'utf8'),
    ]);

    mf = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-11-10',
        modules: true,
        script: bundledCode,
        bindings: { ENDGO_API_TOKEN: TOKEN },
        d1Databases: { DB: 'worker-starter-db' },
      })
    );

    const db = await mf.getD1Database('DB');
    await db.exec(schemaSql.replace(/\s+/g, ' ').trim());
  });

  after(async () => {
    if (mf) {
      await mf.dispose();
    }
  });

  test('GET /health queries real D1 and returns 200 { ok: true, database: true }', async () => {
    const res = await mf.dispatchFetch('http://localhost/health');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, database: true });
  });

  test('PUT /api/items/:id enforces bearerAuth, Standard Schema validation, and D1 persistence', async () => {
    const unauth = await mf.dispatchFetch('http://localhost/api/items/1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Unauthorized item' }),
    });
    assert.equal(unauth.status, 401);

    const invalidJson = await mf.dispatchFetch('http://localhost/api/items/1', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: '{not-valid-json',
    });
    assert.equal(invalidJson.status, 400);

    const invalidSchema = await mf.dispatchFetch('http://localhost/api/items/1', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: '' }),
    });
    assert.equal(invalidSchema.status, 400);

    const putRes = await mf.dispatchFetch('http://localhost/api/items/1', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'First D1 Item' }),
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.equal(putBody.id, '1');
    assert.equal(putBody.title, 'First D1 Item');
    assert.equal(typeof putBody.updated_at, 'string');

    const getRes = await mf.dispatchFetch('http://localhost/api/items/1', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.deepEqual(getBody, putBody);
  });

  test('Reports endpoint supports v1 default, v2 canary, GET fallback, and no POST fallback', async () => {
    const authHeaders = { authorization: `Bearer ${TOKEN}` };

    const v1Res = await mf.dispatchFetch('http://localhost/api/reports/r1', {
      headers: authHeaders,
    });
    assert.equal(v1Res.status, 200);
    assert.deepEqual(await v1Res.json(), {
      id: 'r1',
      version: 'v1',
      source: 'primary',
    });

    const v2Res = await mf.dispatchFetch('http://localhost/api/reports/r1', {
      headers: { ...authHeaders, 'x-canary-cohort': 'v2' },
    });
    assert.equal(v2Res.status, 200);
    assert.deepEqual(await v2Res.json(), {
      id: 'r1',
      version: 'v2',
      source: 'canary',
    });

    const fallbackRes = await mf.dispatchFetch('http://localhost/api/reports/r1?fail=1', {
      headers: { ...authHeaders, 'x-canary-cohort': 'v2' },
    });
    assert.equal(fallbackRes.status, 200);
    assert.deepEqual(await fallbackRes.json(), {
      id: 'r1',
      version: 'v1',
      source: 'fallback',
    });

    const postFailRes = await mf.dispatchFetch('http://localhost/api/reports/r1?fail=1', {
      method: 'POST',
      headers: { ...authHeaders, 'x-canary-cohort': 'v2' },
    });
    assert.equal(postFailRes.status, 500);
  });

  test('Reports endpoint delegates to REPORTS_SERVICE binding when present', async () => {
    const serviceMf = new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          {
            name: 'worker-starter',
            compatibilityDate: '2026-11-10',
            modules: true,
            script: bundledCode,
            bindings: { ENDGO_API_TOKEN: TOKEN },
            d1Databases: { DB: 'worker-starter-service-db' },
            serviceBindings: { REPORTS_SERVICE: 'reports-service' },
          },
          {
            name: 'reports-service',
            compatibilityDate: '2026-11-10',
            modules: true,
            script: `export default {
              async fetch(request) {
                const url = new URL(request.url);
                return Response.json({
                  delegated: true,
                  service: 'reports-service',
                  method: request.method,
                  pathname: url.pathname,
                });
              }
            };`,
          },
        ],
      })
    );

    try {
      const res = await serviceMf.dispatchFetch('http://localhost/api/reports/r1', {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        delegated: true,
        service: 'reports-service',
        method: 'GET',
        pathname: '/api/reports/r1',
      });
    } finally {
      await serviceMf.dispose();
    }
  });
});
