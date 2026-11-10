# Platform-Specific Deployment

This directory contains quick-start configurations and deployment scripts for deploying endGO applications to different edge computing platforms.

## Structure

- **`cloudflare/`** — Cloudflare Workers deployment
- **`fastly/`** — Fastly Compute deployment

## Quick Start

Choose your platform and follow the README in that directory.

### Cloudflare Workers

```bash
cd /path/to/endGO
npm install
npm run build
cd platforms/cloudflare
npm install
npm run check
npm run bundle
npx wrangler login
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
| **Deploy Command** | `wrangler deploy` | `fastly compute deploy` |
| **TypeScript** | Via wrangler build | Via rollup/esbuild |

## Adding Your App

Each platform directory contains a starter `src/index.ts`. Edit that file to add your endpoints and middleware. The Cloudflare starter imports the local endGO package from this checkout; after v1 is published, switch its dependency to the published version.
