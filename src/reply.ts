import type { endGOConfig, endGOCorsConfig } from './types.js';

function buildCorsEntries(cors: endGOCorsConfig): Array<[string, string]> {
  const entries: Array<[string, string]> = [];

  if (cors.origin !== undefined) {
    const originValue = Array.isArray(cors.origin)
      ? cors.origin.join(', ')
      : cors.origin;
    if (originValue) {
      entries.push(['Access-Control-Allow-Origin', originValue]);
    }
  }

  if (cors.methods && cors.methods.length > 0) {
    entries.push(['Access-Control-Allow-Methods', cors.methods.join(', ')]);
  }

  if (cors.headers && cors.headers.length > 0) {
    entries.push(['Access-Control-Allow-Headers', cors.headers.join(', ')]);
  }

  if (cors.credentials === true) {
    entries.push(['Access-Control-Allow-Credentials', 'true']);
  }

  if (typeof cors.maxAge === 'number') {
    entries.push(['Access-Control-Max-Age', String(cors.maxAge)]);
  }

  return entries;
}

function isBinaryOrStreamBody(payload: unknown): payload is BodyInit {
  return (
    payload instanceof Blob ||
    payload instanceof ArrayBuffer ||
    ArrayBuffer.isView(payload) ||
    payload instanceof ReadableStream
  );
}

/**
 * Creates a standardized Web Response builder applying safe defaults and configured CORS headers.
 */
export function createReply(
  config?: endGOConfig
): (status: number, payload?: unknown, headers?: Record<string, string>) => Response {
  const corsEntries = config?.cors ? buildCorsEntries(config.cors) : [];

  return (
    status: number,
    payload?: unknown,
    headers?: Record<string, string>
  ): Response => {
    if (payload instanceof Response) {
      const merged = new Headers(payload.headers);
      if (!merged.has('X-Content-Type-Options')) {
        merged.set('X-Content-Type-Options', 'nosniff');
      }
      for (let i = 0; i < corsEntries.length; i++) {
        const [name, value] = corsEntries[i];
        if (!merged.has(name)) {
          merged.set(name, value);
        }
      }
      if (headers) {
        for (const [name, value] of Object.entries(headers)) {
          merged.set(name, value);
        }
      }
      return new Response(payload.body, {
        status: payload.status,
        statusText: payload.statusText,
        headers: merged,
      });
    }

    const responseHeaders = new Headers();
    responseHeaders.set('X-Content-Type-Options', 'nosniff');

    for (let i = 0; i < corsEntries.length; i++) {
      const [name, value] = corsEntries[i];
      responseHeaders.set(name, value);
    }

    let body: BodyInit | null = null;

    if (status !== 204 && status !== 304 && payload !== undefined) {
      if (typeof payload === 'string') {
        body = payload;
        responseHeaders.set('Content-Type', 'text/plain; charset=utf-8');
      } else if (isBinaryOrStreamBody(payload)) {
        body = payload;
      } else {
        body = JSON.stringify(payload);
        responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
      }
    }

    if (headers) {
      for (const [name, value] of Object.entries(headers)) {
        responseHeaders.set(name, value);
      }
    }

    return new Response(body, {
      status,
      headers: responseHeaders,
    });
  };
}
