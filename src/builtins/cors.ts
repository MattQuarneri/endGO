import type { endGOMiddleware, MiddlewareContext } from '../types.js';

/**
 * Dynamic origin resolver callback for {@link cors}.
 */
export type CorsOriginResolver = (
  origin: string,
  context: MiddlewareContext
) => string | boolean | null | Promise<string | boolean | null>;

/**
 * Configuration options for {@link cors} middleware.
 */
export interface CorsOptions {
  origin?: string | string[] | CorsOriginResolver;
  methods?: string[];
  allowHeaders?: string[];
  exposeHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

const DEFAULT_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'];

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get('Vary');
  if (!existing) {
    headers.set('Vary', value);
    return;
  }

  const parts = existing.split(',').map((part) => part.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase())) {
    headers.set('Vary', `${existing}, ${value}`);
  }
}

async function resolveOrigin(
  option: CorsOptions['origin'],
  requestOrigin: string | null,
  context: MiddlewareContext
): Promise<{ allowOrigin: string | null; varyOrigin: boolean }> {
  if (option === undefined || option === '*') {
    return { allowOrigin: '*', varyOrigin: false };
  }

  if (typeof option === 'string') {
    return { allowOrigin: option, varyOrigin: true };
  }

  if (Array.isArray(option)) {
    if (requestOrigin && option.includes(requestOrigin)) {
      return { allowOrigin: requestOrigin, varyOrigin: true };
    }
    return { allowOrigin: null, varyOrigin: true };
  }

  const resolved = await option(requestOrigin ?? '', context);
  if (typeof resolved === 'string') {
    return { allowOrigin: resolved, varyOrigin: true };
  }
  if (resolved === true) {
    return { allowOrigin: requestOrigin ?? '*', varyOrigin: Boolean(requestOrigin) };
  }
  return { allowOrigin: null, varyOrigin: true };
}

/**
 * Applies Cross-Origin Resource Sharing (CORS) headers and automatically handles
 * `OPTIONS` preflight requests with a `204 No Content` response.
 */
export function cors(
  options: CorsOptions = {}
): endGOMiddleware {
  const methods = options.methods ?? DEFAULT_METHODS;

  return async (context, next) => {
    const requestHeaders = context.request.resolved.headers;
    const requestOrigin = requestHeaders.get('origin');
    const { allowOrigin, varyOrigin } = await resolveOrigin(
      options.origin,
      requestOrigin,
      context
    );

    const applyCommonHeaders = (headers: Headers): void => {
      if (allowOrigin) {
        if (allowOrigin === '*' && options.credentials === true && requestOrigin) {
          headers.set('Access-Control-Allow-Origin', requestOrigin);
          appendVary(headers, 'Origin');
        } else {
          headers.set('Access-Control-Allow-Origin', allowOrigin);
        }
      }

      if (varyOrigin) {
        appendVary(headers, 'Origin');
      }

      if (options.credentials === true) {
        headers.set('Access-Control-Allow-Credentials', 'true');
      }
    };

    if (context.request.resolved.method === 'OPTIONS') {
      const preflightHeaders = new Headers();
      applyCommonHeaders(preflightHeaders);

      if (methods.length > 0) {
        preflightHeaders.set('Access-Control-Allow-Methods', methods.join(', '));
      }

      if (options.allowHeaders && options.allowHeaders.length > 0) {
        preflightHeaders.set(
          'Access-Control-Allow-Headers',
          options.allowHeaders.join(', ')
        );
      } else {
        const requestedHeaders = requestHeaders.get(
          'access-control-request-headers'
        );
        if (requestedHeaders) {
          preflightHeaders.set('Access-Control-Allow-Headers', requestedHeaders);
          appendVary(preflightHeaders, 'Access-Control-Request-Headers');
        }
      }

      if (typeof options.maxAge === 'number') {
        preflightHeaders.set('Access-Control-Max-Age', String(options.maxAge));
      }

      return new Response(null, {
        status: 204,
        headers: preflightHeaders,
      });
    }

    const response = await next();
    const responseHeaders = new Headers(response.headers);
    applyCommonHeaders(responseHeaders);

    if (options.exposeHeaders && options.exposeHeaders.length > 0) {
      responseHeaders.set(
        'Access-Control-Expose-Headers',
        options.exposeHeaders.join(', ')
      );
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  };
}
