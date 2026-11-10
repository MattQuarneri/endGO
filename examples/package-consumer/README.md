# Published package smoke demo

This demo builds endGO, packs it like npm would, installs the tarball in a fresh temporary project, and runs a real Node HTTP server. It checks the public package exports, middleware, router, JSON request body, and response. The temporary project is removed after the check.

From the repository root:

```sh
npm install
node examples/package-consumer/verify.mjs
npm pack --dry-run --json
```

The final `npm pack --dry-run` lets you inspect the exact publish file list without publishing. The smoke check does not need registry access after the root dev dependencies are installed.
