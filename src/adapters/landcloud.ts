import type { CapabilityCatalog, CloudProvider } from '../cloudC.js';
import {
  CloudflareProvider,
  type CloudflareAdapterOptions,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from './cloudflare.js';

type SqliteBinding = string | number | null;

/** The Bun SQLite methods needed by the CloudC SQL adapter. */
export interface BunSQLiteDatabase {
  exec(sql: string): unknown;
  query(sql: string): {
    get(...bindings: SqliteBinding[]): unknown;
    all(...bindings: SqliteBinding[]): unknown[];
    run(...bindings: SqliteBinding[]): { changes: number };
  };
}

export type LandCloudOptions = Pick<CloudflareAdapterOptions,
  'autoMigrate' | 'now' | 'subjectFromRef'>;

class LandCloudProvider extends CloudflareProvider {
  override readonly id = 'landcloud';

  override capabilities(): CapabilityCatalog {
    const { database, index } = super.capabilities();
    return {
      database: { ...database!, global: false, cheap: false },
      index: { ...index!, global: false },
    };
  }
}

/** Reuse the D1 provider's SQLite schema, queries, and CloudC value codec on Bun. */
export function createLandCloudProvider(
  database: BunSQLiteDatabase,
  options: LandCloudOptions = {},
): CloudProvider {
  const sql: D1DatabaseLike = {
    async exec(statement) {
      database.exec(statement);
    },
    prepare(statement) {
      const query = database.query(statement);

      function bind(...values: unknown[]): D1PreparedStatementLike {
        // The shared provider binds only SQL strings, numbers, and nulls.
        const bindings = values as SqliteBinding[];
        return {
          bind,
          async first<Row>(column?: string) {
            const row = query.get(...bindings) as Record<string, unknown> | null | undefined;
            return ((column ? row?.[column] : row) ?? null) as Row | null;
          },
          async all<Row>() {
            return { success: true, results: query.all(...bindings) as Row[] };
          },
          async run() {
            const { changes } = query.run(...bindings);
            return { success: true, meta: { changes } };
          },
        };
      }

      return bind();
    },
  };

  return new LandCloudProvider({ ...options, database: sql });
}
