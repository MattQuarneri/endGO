# Getting Started: Deploy Your First endGO App

Choose your platform and deploy in **less than 5 minutes**.

## Prerequisites

- Node.js 18+
- A terminal
- 5 minutes

## Option 1: Cloudflare Workers (Recommended for Beginners)

**Why:** Free tier, instant global deployment, zero setup

```bash
# 1. Navigate to Cloudflare platform
cd /path/to/endGO/platforms/cloudflare

# 2. Install dependencies
npm install

# 3. Authenticate (opens browser)
npx wrangler login

# 4. Deploy (30 seconds)
npm run deploy

# 5. Done! ✅
# Your app is live at: https://endgo-cloudflare-app.workers.dev
```

**Customize:**
- Edit `src/index.ts` to change your app logic
- Edit `wrangler.toml` to rename your worker
- Redeploy: `npm run deploy`

**Next Steps:**
- [Cloudflare KV Tutorial](./cloudflare/README.md#environment-variables--secrets)
- [Add environment variables](./cloudflare/README.md#environment-variables--secrets)
- [Set up custom domain](./cloudflare/README.md#routing)

---

## Option 2: Fastly Compute (Best Performance)

**Why:** Fastest cold starts (<5ms), powerful real-time capabilities

```bash
# 1. Navigate to Fastly platform
cd /path/to/endGO/platforms/fastly

# 2. Install dependencies
npm install

# 3. Authenticate (opens browser)
fastly auth

# 4. Deploy (30 seconds)
npm run deploy

# 5. Done! ✅
# Your app is live at: https://your-service.edgecompute.app
```

**Customize:**
- Edit `src/index.ts` to change your app logic
- Edit `fastly.toml` to configure backends
- Redeploy: `npm run deploy`

**Next Steps:**
- [Fastly Backends Tutorial](./fastly/README.md#backends-origins)
- [Add dictionaries](./fastly/README.md#environment-variables--secrets)
- [Set up custom domain](./fastly/README.md#routing)

---

## Option 3: Bun (Local Development)

**Why:** Fastest local development, built-in tools

```bash
# 1. Install Bun (if needed)
curl -fsSL https://bun.sh/install | bash

# 2. Navigate to project root
cd /path/to/endGO

# 3. Run directly
bun src/endGO.ts

# 4. Open browser to http://localhost:3000

# 5. Ctrl+C to stop
```

**Customize:**
- Edit `src/endGO.ts` directly
- Changes auto-reload (with hot-reload plugins)
- Export and deploy to edge when ready

**Next Steps:**
- Use as staging before deploying to Cloudflare or Fastly
- Set up TypeScript with `bun add -d typescript`

---

## Option 4: Node.js (Maximum Compatibility)

**Why:** Run anywhere—VPS, Docker, traditional servers

```bash
# 1. Install from project root
npm install

# 2. Create server.ts
cat > server.ts << 'EOF'
import { serveNode } from 'endGO/adapters/node';
import app from './src/endGO';

serveNode(app, 3000, () => {
  console.log('Server running on http://localhost:3000');
});
EOF

# 3. Run it
npx tsx server.ts

# 4. Open browser to http://localhost:3000

# 5. Ctrl+C to stop
```

**Deploy to Cloud:**
- AWS: Use `node server.ts` in Lambda or EC2
- Railway: Connect GitHub repo, Railway detects Node.js
- Render: Connect GitHub repo, set start command
- Heroku: `git push heroku main`
- DigitalOcean: Create App Platform or Droplet

---

## Verify Your Deployment

Each platform provides a health check endpoint:

```bash
# Test your app
curl https://your-domain.com/health

# Expected response:
{
  "status": "ok",
  "platform": "cloudflare-workers"
  // or "fastly-compute", etc.
}
```

## What Happens Next?

After deploying, your endGO app:
- ✅ Accepts HTTP requests
- ✅ Routes to handlers via `.end()` paths
- ✅ Provides immutable `request`, `requestor`, `server` context
- ✅ Runs middleware pipeline automatically
- ✅ Returns JSON/HTML responses

## Troubleshooting

### "I don't see my changes"
```bash
# Rebuild and redeploy
npm run build
npm run deploy
```

### "401 Unauthorized on Cloudflare"
```bash
# Re-authenticate
npx wrangler logout
npx wrangler login
```

### "ENOENT: node_modules/endgo"
```bash
# Install dependencies
npm install
```

### "Port 3000 already in use"
```bash
# Use a different port
npx tsx server.ts --port 3001
```

## Next: Customize Your App

Edit the platform's `src/index.ts`:

```ts
// Add a new endpoint
app.end('/api/hello', async ({ request, server }) => {
  const name = request.resolved.query.get('name') || 'World';
  return server.reply(200, { message: `Hello, ${name}!` });
});

// Add middleware
app.mid('/api/*', async (ctx, next) => {
  const token = ctx.request.resolved.headers.get('authorization');
  if (!token) {
    return ctx.server.reply(401, { error: 'Unauthorized' });
  }
  return next();
});

// Use server context
app.end('/data', async ({ server }) => {
  return server.reply(200, {
    env: server.env,
    timestamp: new Date().toISOString(),
  });
});
```

## Learn More

- [endGO API Reference](../README.md)
- [Platform Comparison](./PLATFORM_COMPARISON.md)
- [Deployment Guide](./DEPLOYMENT.md)
- [Cloudflare Docs](./cloudflare/README.md)
- [Fastly Docs](./fastly/README.md)

---

**You've got this!** 🚀

Pick a platform above, run the commands, and your endGO app is live globally in minutes.
