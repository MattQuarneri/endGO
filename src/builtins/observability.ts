import type { endGOMiddleware, endGORequest, MiddlewareContext } from '../types.js';

/**
 * Configuration options for {@link requestId}.
 */
export interface RequestIdOptions {
  headerName?: string;
  generator?: () => string;
}

const REQUEST_ID_STORE = new WeakMap<endGORequest, string>();

/**
 * Retrieves the request ID assigned to `request` by {@link requestId}.
 */
export function getRequestId(request: endGORequest): string | undefined {
  return REQUEST_ID_STORE.get(request);
}

/**
 * Reads or generates a `crypto.randomUUID()` request ID on the `X-Request-Id`
 * (or configured) header for both incoming requests and outgoing responses.
 */
export function requestId(
  options: RequestIdOptions = {}
): endGOMiddleware {
  const headerName = options.headerName ?? 'X-Request-Id';
  const generator = options.generator ?? (() => crypto.randomUUID());

  return async (context, next) => {
    const incoming = context.request.resolved.headers.get(headerName)?.trim();
    const id = incoming && incoming.length > 0 ? incoming : generator();

    REQUEST_ID_STORE.set(context.request, id);

    if (!incoming) {
      try {
        context.request.resolved.headers.set(headerName, id);
      } catch {
        // Ignore if runtime provides immutable incoming Request headers.
      }
    }

    const response = await next();
    const headers = new Headers(response.headers);
    headers.set(headerName, id);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

/**
 * Configuration options for {@link requestLogger}.
 */
export interface RequestLoggerOptions {
  skip?: (context: MiddlewareContext) => boolean;
}

/**
 * Logs request method, path, response status, and duration using `server.logger.info`.
 */
export function requestLogger(
  options: RequestLoggerOptions = {}
): endGOMiddleware {
  return async (context, next) => {
    if (options.skip?.(context)) {
      return next();
    }

    const start = performance.now();
    const response = await next();
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    const method = context.request.resolved.method;
    const path = context.request.resolved.url.pathname;

    context.server.logger.info(`${method} ${path} ${response.status} ${durationMs}ms`, {
      method,
      path,
      status: response.status,
      durationMs,
    });

    return response;
  };
}
