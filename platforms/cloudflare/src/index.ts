import { endGO } from 'endgo';

type Env = {
  // Add your Cloudflare bindings here
  // Example:
  // CACHE: KVNamespace;
  // API_SECRET: string;
};

const app = new endGO<Env>();

// Global middleware
app.mid('*', async (ctx, next) => {
  const start = performance.now();
  const res = await next();
  const headers = new Headers(res.headers);
  headers.set('X-Response-Time', `${(performance.now() - start).toFixed(2)}ms`);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
});

// Health check endpoint
app.end('/health', ({ server }) =>
  server.reply(200, { status: 'ok', platform: 'cloudflare-workers' })
);

// Example API endpoint
app.end('/api/echo', {
  POST: async ({ request, server }) => {
    if (!request.resolved.body) {
      return server.reply(400, { error: 'Body required' });
    }

    const data = await request.resolved.body.json<Record<string, unknown>>();
    return server.reply(200, { echo: data, timestamp: new Date().toISOString() });
  },
});

export default app;
