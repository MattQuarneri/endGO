import type { endGOMiddleware, MiddlewareContext } from '../types.js';

/**
 * Configuration options for {@link secureHeaders}.
 * Pass `false` for any header to omit it from responses.
 */
export interface SecureHeadersOptions {
  xContentTypeOptions?: string | false;
  xFrameOptions?: string | false;
  referrerPolicy?: string | false;
  xXssProtection?: string | false;
  xDnsPrefetchControl?: string | false;
  xDownloadOptions?: string | false;
  xPermittedCrossDomainPolicies?: string | false;
  crossOriginOpenerPolicy?: string | false;
  crossOriginResourcePolicy?: string | false;
  strictTransportSecurity?: string | false;
  contentSecurityPolicy?: string | false;
}

const DEFAULT_SECURE_HEADERS: ReadonlyArray<
  readonly [keyof SecureHeadersOptions, string, string]
> = [
  ['xContentTypeOptions', 'X-Content-Type-Options', 'nosniff'],
  ['xFrameOptions', 'X-Frame-Options', 'SAMEORIGIN'],
  ['referrerPolicy', 'Referrer-Policy', 'no-referrer'],
  ['xXssProtection', 'X-XSS-Protection', '0'],
  ['xDnsPrefetchControl', 'X-DNS-Prefetch-Control', 'off'],
  ['xDownloadOptions', 'X-Download-Options', 'noopen'],
  ['xPermittedCrossDomainPolicies', 'X-Permitted-Cross-Domain-Policies', 'none'],
  ['crossOriginOpenerPolicy', 'Cross-Origin-Opener-Policy', 'same-origin'],
  ['crossOriginResourcePolicy', 'Cross-Origin-Resource-Policy', 'same-origin'],
  [
    'strictTransportSecurity',
    'Strict-Transport-Security',
    'max-age=15552000; includeSubDomains',
  ],
];

/**
 * Applies defensive HTTP security headers to outgoing responses.
 */
export function secureHeaders(
  options: SecureHeadersOptions = {}
): endGOMiddleware {
  const entries: Array<[string, string]> = [];

  for (const [optionKey, headerName, defaultValue] of DEFAULT_SECURE_HEADERS) {
    const value = options[optionKey];
    if (value === false) continue;
    entries.push([headerName, value ?? defaultValue]);
  }

  if (options.contentSecurityPolicy && typeof options.contentSecurityPolicy === 'string') {
    entries.push(['Content-Security-Policy', options.contentSecurityPolicy]);
  }

  return async (_context, next) => {
    const response = await next();
    const headers = new Headers(response.headers);

    for (let i = 0; i < entries.length; i++) {
      const [name, value] = entries[i];
      if (!headers.has(name)) {
        headers.set(name, value);
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

/**
 * Configuration options for {@link bodyLimit}.
 */
export interface BodyLimitOptions {
  maxBytes: number;
  onError?: (
    context: MiddlewareContext
  ) => Response | Promise<Response>;
}

function buildPayloadTooLargeResponse(
  context: MiddlewareContext,
  options: BodyLimitOptions
): Response | Promise<Response> {
  if (options.onError) {
    return options.onError(context);
  }
  return context.server.reply(413, {
    error: 'Payload Too Large',
    maxBytes: options.maxBytes,
  });
}

/**
 * Enforces a maximum request body size in bytes by inspecting `Content-Length` and
 * streaming the cloned body without consuming the downstream `request.resolved.body`.
 */
export function bodyLimit(
  options: BodyLimitOptions
): endGOMiddleware {
  return async (context, next) => {
    const contentLengthHeader =
      context.request.resolved.headers.get('content-length');

    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
        return buildPayloadTooLargeResponse(context, options);
      }
    }

    if (context.request.raw.body !== null && context.request.resolved.body !== null) {
      const cloned = context.request.raw.clone();
      const reader = cloned.body?.getReader();

      if (reader) {
        let totalBytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > options.maxBytes) {
              await reader.cancel();
              return buildPayloadTooLargeResponse(context, options);
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
    }

    return next();
  };
}
