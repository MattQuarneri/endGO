# Deployment Quick Start

This guide shows how to get your endGO app running on any platform in under 5 minutes.

## Cloudflare Workers

```bash
cd platforms/cloudflare
npm install
npx wrangler login
npm run deploy
```

✅ Your app is live at `https://your-project.workers.dev`

[Full Cloudflare Guide →](./cloudflare/README.md)

## Fastly Compute

```bash
cd platforms/fastly
npm install
fastly auth
npm run deploy
```

✅ Your app is live at `https://your-service.edgecompute.app`

[Full Fastly Guide →](./fastly/README.md)

## Local Development

### Cloudflare (with live reload)
```bash
cd platforms/cloudflare
npm run dev
# Open http://localhost:8787
```

### Fastly
```bash
cd platforms/fastly
npm run dev
# Open http://localhost:7676
```

### Bun
```bash
cd /root
bun ./src/endGO.ts
# Open http://localhost:3000
```

### Node.js
Create a file:
```ts
// index.ts
import { serveNode } from 'endGO/adapters/node';
import app from './src/endGO';

serveNode(app, 3000, () => console.log('Listening on :3000'));
```

Then:
```bash
npx tsx index.ts
```

## Environment-Specific Deployment

### Cloudflare Multi-Environment
```bash
# Deploy to staging
npm run deploy -- --env staging

# Deploy to production
npm run deploy -- --env production
```

Configure in `wrangler.toml`:
```toml
[env.staging]
route = "api-staging.example.com/*"
zone_id = "xxx"

[env.production]
route = "api.example.com/*"
zone_id = "yyy"
```

### Fastly Multi-Environment
```bash
# Deploy to staging service
FASTLY_SERVICE_ID=staging-id npm run deploy

# Deploy to production service
FASTLY_SERVICE_ID=production-id npm run deploy
```

## CI/CD Pipelines

Both platforms include GitHub Actions workflows:

- **Cloudflare:** `.github/workflows/deploy.yml` — Auto-deploy on push to main
- **Fastly:** `.github/workflows/deploy.yml` — Auto-deploy on push to main

Secrets to configure:

### Cloudflare
- `CLOUDFLARE_API_TOKEN` — API token from Cloudflare dashboard
- `CLOUDFLARE_ACCOUNT_ID` — Account ID

### Fastly
- `FASTLY_API_TOKEN` — API token from Fastly dashboard
- `FASTLY_SERVICE_ID` — Service ID for production

## Scaling & Performance

| Platform | Cold Start | Typical Response | Global Footprint |
|----------|-----------|------------------|------------------|
| Cloudflare | <10ms | 30-50ms | 300+ cities |
| Fastly | <5ms | 20-40ms | 60+ POPs |
| Bun | 50-100ms | 5-15ms | Local only |
| Node.js | 50-100ms | 5-15ms | Local only |

## Cost Estimation

### Cloudflare Workers (Free Tier)
- **Free:** 100k requests/day
- **Paid:** $0.50/10M requests + $0.50/GB KV storage

### Fastly Compute (Pay-as-you-go)
- **Compute:** $0.12 per 1M requests
- **Edge Dictionary:** $0.20/GB

### Bun/Node.js (Self-hosted)
- **VPS (DigitalOcean):** $4-6/month
- **Docker (AWS Fargate):** ~$5-20/month depending on load

## Troubleshooting

### Cloudflare: "401 Unauthorized"
```bash
# Re-authenticate
wrangler login

# Check API token permissions (must have Workers, KV, and Account Settings scopes)
```

### Fastly: "Service not found"
```bash
# Verify service ID
fastly service list

# Set correct service ID
FASTLY_SERVICE_ID=xxx npm run deploy
```

### Type errors on deploy
```bash
npm run check  # Run type-check before deploying
```

### Environment variables not loading
- **Cloudflare:** Check `[vars]` section in `wrangler.toml`
- **Fastly:** Check `backends` and `[env]` sections in `fastly.toml`

## Next Steps

1. **Customize your app:** Edit `src/index.ts`
2. **Add dependencies:** Update platform `package.json`
3. **Add environment variables:** Update platform config file
4. **Deploy:** `npm run deploy`
5. **Monitor:** Check logs with `npm run dev` or platform dashboard

For detailed platform documentation:
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Fastly Compute Docs](https://developer.fastly.com/learning/compute/)
