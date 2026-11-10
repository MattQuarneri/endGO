# endGO Platforms Quick Reference Card

## 📋 What's in `platforms/`?

A complete deployment infrastructure for Cloudflare Workers and Fastly Compute, including:
- **Configuration files** (wrangler.toml, fastly.toml)
- **Example applications** (TypeScript/JavaScript)
- **Comprehensive documentation** (guides, comparisons, tutorials)

## 🚀 Deploy in 5 Minutes

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
npm install
fastly auth
npm run deploy
```

## 📚 Documentation Files

| File | Purpose |
|------|---------|
| `platforms/GETTING_STARTED.md` | 5-minute deployment guide |
| `platforms/README.md` | Platform overview & links |
| `platforms/DEPLOYMENT.md` | Full deployment instructions |
| `platforms/PLATFORM_COMPARISON.md` | Feature matrix & cost analysis |
| `platforms/cloudflare/README.md` | Cloudflare Workers guide |
| `platforms/fastly/README.md` | Fastly Compute guide |

## 🔧 Customization Checklist

- [ ] Edit `wrangler.toml` (Cloudflare) or `fastly.toml` (Fastly)
  - [ ] Change app name
- [ ] Configure the deployment account or service
  - [ ] Configure environment variables
- [ ] Edit `src/index.ts`
  - [ ] Replace example endpoints with your app

## ⚡ npm Scripts

```bash
npm run dev          # Local development server
npm run check        # TypeScript type checking
npm run bundle       # Cloudflare dry-run bundle
npm run deploy       # Deploy to platform
```

## 💡 Platform Comparison

| Feature | Cloudflare | Fastly |
|---------|-----------|--------|
| **Cost** | $0.50/10M req | $0.12/1M req |
| **Free Tier** | ✅ 100k/day | ❌ |
| **Cold Start** | <10ms | <5ms |
| **Global Reach** | 300+ cities | 60+ POPs |
| **Setup Time** | 2 min | 2 min |
| **Storage** | ✅ KV | ✅ Dictionary |

## 📍 Choose Platform By Scenario

- **Want free tier?** → Cloudflare
- **Need ultra-low latency?** → Fastly
- **Just learning?** → Cloudflare (simpler)
- **Production with budget?** → Fastly (cheaper)
- **Local dev first?** → Use `bun` or `node`, then deploy

## 🔗 Key Files to Customize

```
platforms/cloudflare/
├─ wrangler.toml        ← Edit: name, account_id, variables
└─ src/index.ts         ← Edit: Your application logic

platforms/fastly/
├─ fastly.toml          ← Edit: name, backends, dictionaries
└─ src/index.ts         ← Edit: Your application logic
```

## ✅ Before Deploying

```bash
# 1. Type-check your code
npm run check

# 2. Test locally
npm run dev

# 3. Verify endpoints work
curl http://localhost:8787/health    # Cloudflare
curl http://localhost:7676/health    # Fastly

# 4. Commit changes
git add platforms/
git commit -m "Deploy to edge platform"

# 5. Deploy
npm run deploy
```

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| "401 Unauthorized" | Re-run `wrangler login` (CF) or `fastly auth` |
| "Service not found" | Check FASTLY_SERVICE_ID environment variable |
| TypeScript errors | Run `npm run check` to see all errors |
| Port already in use | Stop other dev servers or use different port |
| Changes not live | Run `npm run deploy` again; Cloudflare bundles the source |

## 📖 Learning Path

1. **New?** Read `platforms/GETTING_STARTED.md`
2. **Comparing?** Check `platforms/PLATFORM_COMPARISON.md`
3. **Deploying?** Follow platform-specific README
4. **Scaling?** See `platforms/DEPLOYMENT.md`

## 🔄 Development Workflow

```
Local Bun Development
    ↓
Test with `npm run dev`
    ↓
Deploy to Cloudflare/Fastly
    ↓
Monitor in platform dashboard
    ↓
Update app → Re-deploy
```

## 🎯 Next Steps

1. Navigate to `platforms/cloudflare` or `platforms/fastly`
2. Follow the README.md in that directory
3. Customize `src/index.ts` with your app
4. Run `npm run deploy`
5. Your app is live! ✅

---

**For detailed information, see the full documentation in `platforms/` directory.**
