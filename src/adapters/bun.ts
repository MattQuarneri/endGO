/**
 * Minimal application contract accepted by runtime adapters.
 */
export interface endGOFetchApp {
  fetch: (req: Request) => Response | Promise<Response>;
  emit?: (event: 'startup' | 'shutdown', payload?: unknown) => Promise<void>;
}

/**
 * Options accepted by {@link serveBun}.
 */
export type BunServeOptions =
  | number
  | string
  | {
      port?: number | string;
      hostname?: string;
      [key: string]: unknown;
    };

/**
 * Starts a Bun HTTP server bound to the provided endGO application's `fetch` handler.
 */
export function serveBun(
  app: endGOFetchApp,
  options?: BunServeOptions,
  callback?: () => void
): unknown {
  const bunGlobal = (globalThis as { Bun?: { serve?: (opts: Record<string, unknown>) => unknown } }).Bun;
  if (typeof bunGlobal?.serve !== 'function') {
    throw new Error(
      'Bun runtime is not available. Use app.fetch for Cloudflare Workers/Deno or serveNode from "endGO/adapters/node" for Node.js.'
    );
  }

  let port: number | undefined;
  let hostname: string | undefined;

  if (typeof options === 'number') {
    port = options;
  } else if (typeof options === 'string') {
    const parsed = Number(options);
    if (!Number.isNaN(parsed)) {
      port = parsed;
    }
  } else if (options && typeof options === 'object') {
    if (typeof options.port === 'number') {
      port = options.port;
    } else if (typeof options.port === 'string') {
      const parsed = Number(options.port);
      if (!Number.isNaN(parsed)) {
        port = parsed;
      }
    }
    if (typeof options.hostname === 'string') {
      hostname = options.hostname;
    }
  }

  const serveConfig: Record<string, unknown> = {
    fetch: app.fetch,
  };
  if (port !== undefined) {
    serveConfig.port = port;
  }
  if (hostname !== undefined) {
    serveConfig.hostname = hostname;
  }

  const server = bunGlobal.serve(serveConfig);
  void app.emit?.('startup', server);
  callback?.();
  return server;
}
