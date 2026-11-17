import CloudC, { type CloudAdapter } from '../../src/cloudC.js';
import { endGO } from '../../src/index.js';

/** The HTTP routes are identical in both entry points. */
export function createStorageApp(provider: CloudAdapter, backend: 'sqlite' | 'd1', token: string) {
  const cloud = new CloudC({ provider });
  const app = new endGO();

  app.end('/health', ({ server }) => server.reply(200, { backend }));
  app.mid('/records/*', ({ request, server }, next) => {
    if (request.raw.headers.get('Authorization') !== `Bearer ${token}`) {
      return server.reply(401, { error: 'Unauthorized' });
    }
    return next();
  });

  app.end('/records/:id', {
    GET: async ({ request, server }) => {
      const value = await cloud.Read(`record:${request.resolved.params.id}`);
      return value === undefined
        ? server.reply(404, { error: 'Record not found' })
        : server.reply(200, value);
    },
    PUT: async ({ request, server }) => {
      let value: unknown;
      try {
        value = await request.resolved.body?.json();
      } catch {
        return server.reply(400, { error: 'Invalid JSON' });
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return server.reply(400, { error: 'Expected a JSON object' });
      }
      await cloud.Write(`record:${request.resolved.params.id}`, value);
      return server.reply(200, value);
    },
    DELETE: async ({ request, server }) => {
      await cloud.Delete(`record:${request.resolved.params.id}`);
      return server.reply(204);
    },
  });

  return app;
}
