import assert from 'node:assert/strict';
import { once } from 'node:events';
import { endGO } from 'endgo';
import { serveNode } from 'endgo/adapters/node';
import { RegExRouter } from 'endgo/routers';

const app = new endGO({ Router: new RegExRouter() });

app.mid('*', async (_context, next) => {
  const response = await next();
  const headers = new Headers(response.headers);
  headers.set('x-demo', 'package-consumer');
  return new Response(response.body, { status: response.status, headers });
});

app.end('/health', ({ server }) => server.reply(200, { status: 'ok' }));
app.end('/echo', {
  POST: async ({ request, server }) => {
    const value = await request.resolved.body?.json();
    return server.reply(200, { echo: value });
  },
});

const server = serveNode(app, { port: 0, hostname: '127.0.0.1' });
try {
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-demo'), 'package-consumer');
  assert.deepEqual(await health.json(), { status: 'ok' });

  const echo = await fetch(`${base}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hello' }),
  });
  assert.equal(echo.status, 200);
  assert.deepEqual(await echo.json(), { echo: { message: 'hello' } });

  console.log('Installed tarball: Node server, middleware, router, and JSON body passed');
} finally {
  if (server.listening) {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}
