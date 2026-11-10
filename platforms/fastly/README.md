# Fastly Compute Deployment

Deploy your endGO app to Fastly Compute@Edge in minutes.

## Prerequisites

- Node.js 18+
- A Fastly account (free tier works)
- `@fastly/cli` (Fastly CLI)

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Authenticate with Fastly:**
   ```bash
   fastly auth
   ```

3. **Update `fastly.toml`:**
   - Change `name` to your project name
   - Add your backends (origin servers) as needed
   - Configure dictionaries for key-value storage

## Development

```bash
# Run local development server
npm run dev

# Type-check
npm run check
```

## Deployment

```bash
# Build and deploy to Fastly
npm run deploy

# Deploy to a specific service
fastly compute deploy --service-id=your-service-id
```

## Environment Variables & Secrets

Add to `fastly.toml`:

```toml
[build]
backends = [
  { name = "origin", address = "api.example.com", port = 443 }
]

[[dictionaries]]
name = "config"
file = "dictionaries/config.json"
```

Access in your app:

```ts
app.end('/config', async ({ server }) => {
  const config = server.env.CONFIG; // Dictionary binding
  // Use Dictionary API
  server.reply(200, { config: {} });
});
```

## Monitoring

View logs:

```bash
fastly log tail
```

View in Fastly dashboard:
- Services → Your Service → Logs
- Real-time analytics and metrics

## Backends (Origins)

Configure in `fastly.toml`:

```toml
[build]
backends = [
  { name = "origin", address = "api.example.com", port = 443 }
]
```

Or add via CLI:

```bash
fastly backend create --service-id=your-service-id
```

## Routing

Deploy to a Fastly domain:
- Deploy to `https://your-service.edgecompute.app`
- Attach to custom domain via Fastly dashboard

Or use as origin for your own domain via Fastly edge.

## Secrets Management

Store sensitive values using Fastly's object store or pass via environment:

```bash
fastly secret store create --service-id=your-service-id --name=API_KEY
```
