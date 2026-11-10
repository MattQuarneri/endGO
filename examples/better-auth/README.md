# Better Auth middleware demo

This example mounts Better Auth in endGO middleware and protects an endGO endpoint with a Better Auth session. Better Auth remains a normal dependency of this example; no code or dependency is added to the endGO framework package or the separate Better Auth repository.

Requires Node.js 22.13+ and a built endGO package. From the endGO repository root:

```sh
bun run build
cd examples/better-auth
bun install
BETTER_AUTH_SECRET="$(openssl rand -base64 32)" npm run start
```

The demo creates a local SQLite database and migrates the Better Auth schema at startup. Set `DEMO_DB_PATH` to use a different file. To try the full flow, use an HTTP client that retains cookies:

```sh
curl -i http://localhost:3000/health
curl -i http://localhost:3000/api/me
curl -i -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"name":"Demo User","email":"demo@example.com","password":"password123"}' \
  http://localhost:3000/api/auth/sign-up/email
curl -i -b cookies.txt http://localhost:3000/api/me
```

The auth middleware forwards `/api/auth/*` to `auth.handler(request.raw)`. The `/api/me` middleware passes the incoming headers to `auth.api.getSession`, returns 401 when no session exists, and writes the user and session into a new frozen `requestor` snapshot. The endpoint reads that snapshot. Auth requests are not body-parsed by endGO before Better Auth receives them.

Run `npm run check` and `npm test` from this directory after installation.
