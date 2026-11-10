// @ts-ignore — host projects with @types/node resolve node:http natively
import * as http from 'node:http';

import type { endGOFetchApp } from './bun.js';

/** Structural Node IncomingMessage subset to avoid requiring @types/node at build time. */
export interface NodeIncomingMessage {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { encrypted?: boolean };
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  destroy(): void;
}

/** Structural Node ServerResponse subset to avoid requiring @types/node at build time. */
export interface NodeServerResponse {
  headersSent: boolean;
  destroyed: boolean;
  writableEnded: boolean;
  setHeader(name: string, value: string | string[]): unknown;
  writeHead(statusCode: number, statusMessageOrHeaders?: string | Record<string, string>): unknown;
  write(chunk: Uint8Array): boolean;
  end(data?: string): unknown;
  destroy(): void;
  once(event: 'drain' | 'close', listener: () => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
  off(event: 'drain' | 'close' | 'error', listener: (...args: never[]) => void): unknown;
}

/** Structural Node http.Server subset returned by {@link serveNode}. */
export interface NodeHttpServer {
  listen(port?: number, hostname?: string, listeningListener?: () => void): this;
  close(callback?: (err?: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

/**
 * Options accepted by {@link serveNode}.
 */
export type NodeServeOptions =
  | number
  | {
      port?: number;
      hostname?: string;
    };

/**
 * Converts an `http.IncomingMessage` into a Web Standard `Request`,
 * streaming the request body for methods other than `GET` and `HEAD`.
 */
function toWebRequest(nodeReq: NodeIncomingMessage): Request {
  const socket = nodeReq.socket as { encrypted?: boolean } | undefined;
  const protocol = socket?.encrypted ? 'https' : 'http';
  const host = nodeReq.headers.host || 'localhost';
  const rawPath = nodeReq.url || '/';

  let fullUrl: string;
  try {
    fullUrl = new URL(rawPath, `${protocol}://${host}`).href;
  } catch {
    fullUrl = `${protocol}://${host}/`;
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeReq.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }

  const method = (nodeReq.method || 'GET').toUpperCase();
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
  };

  if (method !== 'GET' && method !== 'HEAD') {
    const encoder = new TextEncoder();
    init.body = new ReadableStream<Uint8Array>({
      start(controller) {
        nodeReq.on('data', (chunk: Uint8Array | string) => {
          const bytes =
            typeof chunk === 'string'
              ? encoder.encode(chunk)
              : chunk instanceof Uint8Array
                ? chunk
                : new Uint8Array(chunk);
          controller.enqueue(bytes);
        });
        nodeReq.on('end', () => {
          controller.close();
        });
        nodeReq.on('error', (err: Error) => {
          controller.error(err);
        });
      },
      cancel() {
        nodeReq.destroy();
      },
    });
    init.duplex = 'half';
  }

  return new Request(fullUrl, init);
}

/**
 * Waits for a Node.js `ServerResponse` drain or close event during backpressure.
 */
function waitForDrain(nodeRes: NodeServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      nodeRes.off('drain', onDrain);
      nodeRes.off('close', onClose);
      nodeRes.off('error', onError);
    };

    nodeRes.once('drain', onDrain);
    nodeRes.once('close', onClose);
    nodeRes.once('error', onError);
  });
}

/**
 * Writes a Web Standard `Response` back to a Node.js `http.ServerResponse`,
 * streaming body chunks with backpressure handling.
 */
async function writeWebResponse(
  webRes: Response,
  nodeRes: NodeServerResponse
): Promise<void> {
  const headersWithCookies = webRes.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies =
    typeof headersWithCookies.getSetCookie === 'function'
      ? headersWithCookies.getSetCookie()
      : [];

  for (const [key, value] of webRes.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie' && setCookies.length > 0) {
      continue;
    }
    nodeRes.setHeader(key, value);
  }

  if (setCookies.length > 0) {
    nodeRes.setHeader('set-cookie', setCookies);
  }

  if (webRes.statusText) {
    nodeRes.writeHead(webRes.status, webRes.statusText);
  } else {
    nodeRes.writeHead(webRes.status);
  }

  if (!webRes.body) {
    nodeRes.end();
    return;
  }

  const reader = webRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (nodeRes.destroyed || nodeRes.writableEnded) {
        await reader.cancel().catch(() => {});
        break;
      }
      if (value && value.byteLength > 0) {
        const canContinue = nodeRes.write(value);
        if (!canContinue) {
          await waitForDrain(nodeRes);
        }
      }
    }
  } finally {
    reader.releaseLock();
    if (!nodeRes.destroyed && !nodeRes.writableEnded) {
      nodeRes.end();
    }
  }
}

/**
 * Starts a Node.js `http.Server` bound to the provided endGO application's `fetch` handler.
 */
export function serveNode(
  app: endGOFetchApp,
  options?: NodeServeOptions,
  callback?: () => void
): NodeHttpServer {
  const port = typeof options === 'number' ? options : options?.port;
  const hostname = typeof options === 'object' ? options?.hostname : undefined;

  const server: NodeHttpServer = http.createServer(
    async (nodeReq: NodeIncomingMessage, nodeRes: NodeServerResponse) => {
    try {
      const webReq = toWebRequest(nodeReq);
      const webRes = await app.fetch(webReq);
      await writeWebResponse(webRes, nodeRes);
    } catch {
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(500, { 'content-type': 'application/json' });
        nodeRes.end(JSON.stringify({ error: 'Internal Server Error' }));
      } else if (!nodeRes.destroyed) {
        nodeRes.destroy();
      }
    }
  });

  server.on('close', () => {
    void app.emit?.('shutdown', server);
  });

  server.listen(port, hostname, () => {
    void app.emit?.('startup', server);
    callback?.();
  });

  return server;
}
