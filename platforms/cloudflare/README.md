# Cloudflare Workers Deployment

Deploy your endGO app to Cloudflare Workers in minutes.

## Prerequisites

- Node.js 18+
- A Cloudflare account (free tier works)
- `wrangler` CLI

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Authenticate with Cloudflare:**
   ```bash
   npx wrangler login
   ```

3. **Update `wrangler.toml`:**
   - Change `name` to your project name
   - Set your `account_id` and `zone_id` (from Cloudflare dashboard)
   - Add any KV bindings or environment variables

## Development

```bash
# Run local development server
npm run dev

# Type-check
npm run check
```

## Deployment

```bash
# Build and deploy to Cloudflare
npm run deploy

# Deploy with a custom message
wrangler publish --message "Production v1.0"
```

## Environment Variables & Secrets

Add to `wrangler.toml`:

```toml
[env.production]
vars = { API_BASE = "https://api.example.com" }

[[env.production.kv_namespaces]]
binding = "TASK_KV"
id = "your-kv-namespace-id"
```

Access in your app:

```ts
app.end('/tasks', async ({ server }) => {
  const kv = server.env.TASK_KV;
  // Use KV API
  server.reply(200, { ok: true });
});
```

## Monitoring

View logs:

```bash
wrangler tail
```

View in Cloudflare dashboard:
- Workers → Your Worker → Logs
- Analytics for request metrics

## Routing

Set up routes in `wrangler.toml`:

```toml
routes = [
  { pattern = "api.example.com/*", zone_name = "example.com" },
  { pattern = "api.staging.example.com/*", zone_name = "example.com" }
]
```

Or deploy as a custom domain at `https://your-project.workers.dev`.
