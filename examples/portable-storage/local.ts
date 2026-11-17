import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import { createLandCloudProvider } from '../../src/adapters/landcloud.js';
import { createStorageApp } from './app.js';

const filename = process.env.ENDGO_DB_PATH
  ?? fileURLToPath(new URL('./.local/storage.sqlite', import.meta.url));
const token = process.env.ENDGO_STORAGE_TOKEN ?? 'local-demo';
const port = Number(process.env.ENDGO_PORT ?? '3000');

if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
const database = new Database(filename);
database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

const app = createStorageApp(createLandCloudProvider(database), 'sqlite', token);
const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: app.fetch });
console.log(`endGO storage demo at ${server.url} using SQLite at ${filename}`);

async function stop() {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  try {
    await server.stop();
  } finally {
    database.close();
  }
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
