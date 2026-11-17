import { createCloudflareProvider, type D1DatabaseLike } from '../../src/adapters/cloudflare.js';
import { createStorageApp } from './app.js';

interface Env {
  DB: D1DatabaseLike;
  ENDGO_STORAGE_TOKEN?: string;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    if (!env.ENDGO_STORAGE_TOKEN) {
      return new Response('Storage demo token is missing', { status: 503 });
    }
    const provider = createCloudflareProvider({ database: env.DB }, { autoMigrate: false });
    return createStorageApp(provider, 'd1', env.ENDGO_STORAGE_TOKEN).fetch(request);
  },
};
