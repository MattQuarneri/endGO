# Cloudflare Workers starter

This starter uses the endGO package from this checkout and Wrangler 4 (Node.js 22.12+). From the repository root, build endGO first:

```sh
npm install
npm run build
cd platforms/cloudflare
npm install
npm run check
npm run bundle
npm run dev
```

In another terminal, verify the local Worker:

```sh
curl http://localhost:8787/health
curl http://localhost:8787/api/hello
curl -X POST http://localhost:8787/api/echo \
  -H 'Content-Type: application/json' -d '{"message":"hi"}'
```

`/api/hello` reads `GREETING` from the Wrangler variable in `wrangler.toml`. Change that value to see how Worker bindings reach `server.env` for each request. Add KV, D1, or other bindings to `wrangler.toml` and the `Env` type as needed.

After publishing endGO v1, replace `"endgo": "file:../.."` in this starter's `package.json` with the published version. To deploy, authenticate with `npx wrangler login`, then run `npm run deploy`. Deployment publishes a Worker to your Cloudflare account; the local checks above do not.
