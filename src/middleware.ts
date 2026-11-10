import { normalizePath, splitSegments } from './routers/shared.js';
import type {
  DefaultEnv,
  endGOMiddleware,
  IRouter,
  MiddlewareContext,
  PathResolver,
} from './types.js';

/**
 * Matches an incoming request pathname against a middleware path pattern.
 *
 * Supported patterns:
 * - `'*'` or `'/*'`: matches every path.
 * - Prefix wildcard (e.g. `'/api/*'`, `'/orgs/:id/*'`): matches the prefix path itself
 *   (e.g. `'/api'`) as well as any nested path beneath it (e.g. `'/api/users'`).
 * - Exact or parameterized paths (e.g. `'/tasks'`, `'/tasks/:id'`): matches exact normalized
 *   segment count where `:param` segments match any non-empty segment.
 */
export function matchMiddlewarePattern(pattern: string, path: string): boolean {
  if (pattern === '*') {
    return true;
  }

  const normalizedPattern = normalizePath(pattern);
  if (normalizedPattern === '/*') {
    return true;
  }

  const normalizedPath = normalizePath(path);
  const patternSegments = splitSegments(normalizedPattern);
  const pathSegments = splitSegments(normalizedPath);

  if (
    patternSegments.length > 0 &&
    patternSegments[patternSegments.length - 1] === '*'
  ) {
    const prefixSegments = patternSegments.slice(0, -1);
    if (pathSegments.length < prefixSegments.length) {
      return false;
    }
    return matchSegments(prefixSegments, pathSegments, prefixSegments.length);
  }

  if (patternSegments.length !== pathSegments.length) {
    return false;
  }

  return matchSegments(patternSegments, pathSegments, patternSegments.length);
}

/**
 * Compares `count` leading segments of `patternSegments` against `pathSegments`.
 */
function matchSegments(
  patternSegments: string[],
  pathSegments: string[],
  count: number
): boolean {
  for (let i = 0; i < count; i++) {
    const pat = patternSegments[i];
    const seg = pathSegments[i];

    if (seg.length === 0) {
      return false;
    }

    if (pat.startsWith(':') && pat.length > 1) {
      continue;
    }

    if (pat !== seg) {
      return false;
    }
  }
  return true;
}

/**
 * Composes an onion-style middleware pipeline around a terminal handler.
 * Guards against invoking `next()` more than once within the same middleware frame.
 */
export function composePipeline<
  TEnv = DefaultEnv,
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
  TRouter = IRouter<any>,
  TResolver = PathResolver
>(
  middlewares: endGOMiddleware<
    TEnv,
    TParams,
    TQuery,
    TUser,
    TTenant,
    TSession,
    TRouter,
    TResolver
  >[],
  context: MiddlewareContext<
    TEnv,
    TParams,
    TQuery,
    TUser,
    TTenant,
    TSession,
    TRouter,
    TResolver
  >,
  terminal: () => Promise<Response>
): Promise<Response> {
  let index = -1;

  async function dispatch(i: number): Promise<Response> {
    if (i <= index) {
      throw new Error('next() called multiple times');
    }
    index = i;

    if (i >= middlewares.length) {
      return terminal();
    }

    const middleware = middlewares[i];
    return middleware(context, () => dispatch(i + 1));
  }

  return dispatch(0);
}
