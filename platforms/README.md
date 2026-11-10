# Platform-Specific Deployment

This directory contains quick-start configurations and deployment scripts for deploying endGO applications to different edge computing platforms.

## Structure

- **`cloudflare/`** — Cloudflare Workers deployment
- **`fastly/`** — Fastly Compute deployment

## Quick Start

Choose your platform and follow the README in that directory.

### Cloudflare Workers

```bash
cd platforms/cloudflare
npm install -g wrangler
npm run build
npm run deploy
```

### Fastly Compute

```bash
cd platforms/fastly
npm install -g @fastly/cli
npm run build
npm run deploy
```

## Platform Comparison

| Feature | Cloudflare | Fastly |
|---------|-----------|--------|
| **Config Format** | `wrangler.toml` | `fastly.toml` |
| **KV Storage** | `KVNamespace` | `Dictionary` |
| **Environment** | Worker environment | Compute@Edge |
| **Deploy Command** | `wrangler publish` | `fastly compute deploy` |
| **TypeScript** | Via wrangler build | Via rollup/esbuild |

## Adding Your App

Each platform directory contains a starter `src/index.ts`. Replace it with your endGO application or import it from your main project.

To use from your main endGO project:

```ts
// platforms/cloudflare/src/index.ts
import app from '../../src/endGO';

export default app;
```
