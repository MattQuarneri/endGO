import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { endGO } from '../../dist/index.js';
import { serveNode } from '../../dist/adapters/node.js';

/** Keep Better Auth configuration in the consuming app, outside endGO itself. */
export function createDemoAuth(database: DatabaseSync, secret: string) {
  return betterAuth({
    baseURL: 'http://localhost:3000',
    secret,
    database,
    emailAndPassword: { enabled: true },
  });
}

export function createDemoApp(auth: ReturnType<typeof createDemoAuth>) {
  const app = new endGO();

  // Better Auth receives the original Web Request, including its body and cookies.
  // Middleware runs even when endGO has no matching route for this path.
  app.mid('/api/auth/*', ({ request }) => auth.handler(request.raw));

  // Only the protected endpoint resolves a session. Public and auth paths stay public.
  app.mid('/api/me', async (context, next) => {
    const result = await auth.api.getSession({
      headers: context.request.raw.headers,
    });
    if (!result) {
      return context.server.reply(401, { error: 'Unauthorized' });
    }

    context.requestor = Object.freeze({
      ...context.requestor,
      user: result.user,
      session: result.session,
      authProvider: 'better-auth',
    });
    return next();
  });

  app.end('/health', ({ server }) => server.reply(200, { status: 'ok' }));
  app.end('/api/me', ({ requestor, server }) =>
    server.reply(200, { user: requestor.user })
  );

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('Set BETTER_AUTH_SECRET to a random value of at least 32 characters');
  }

  const database = new DatabaseSync(process.env.DEMO_DB_PATH ?? 'better-auth-demo.sqlite');
  const auth = createDemoAuth(database, secret);
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  serveNode(createDemoApp(auth), { port: 3000 }, () => {
    console.log('endGO + Better Auth demo listening on http://localhost:3000');
  });
}
