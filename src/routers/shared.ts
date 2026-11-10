/**
 * Standard HTTP methods supported when a catch-all handler or `ANY` verb is registered.
 */
const STANDARD_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'HEAD',
  'QUERY',
  'CONNECT',
  'TRACE'
] as const;

/**
 * Result of resolving an HTTP method against a registered route payload.
 */
export interface VerbResolution<THandler> {
  handler: THandler | null;
  allowedMethods: string[];
}

/**
 * Normalizes a route or request pathname by ensuring a leading slash
 * and stripping trailing slashes (preserving the root `'/'`).
 */
export function normalizePath(path: string): string {
  const withLeading = path.startsWith('/') ? path : `/${path}`;
  const trimmed = withLeading.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Splits a normalized path into non-empty segments.
 */
export function splitSegments(normalizedPath: string): string[] {
  return normalizedPath === '/' ? [] : normalizedPath.slice(1).split('/');
}

/**
 * Resolves the effective handler and allowed HTTP methods for a given route payload and method.
 */
export function resolveVerb<THandler>(
  payload: THandler | Record<string, THandler | undefined>,
  method: string
): VerbResolution<THandler> {
  if (typeof payload === 'function') {
    return {
      handler: payload,
      allowedMethods: [...STANDARD_METHODS],
    };
  }

  if (typeof payload !== 'object' || payload === null) {
    return {
      handler: null,
      allowedMethods: [],
    };
  }

  const upperMethod = method.toUpperCase();
  const verbMap = new Map<string, THandler>();
  const excluded = new Set<string>();

  for (const [rawVerb, fn] of Object.entries(
    payload as Record<string, THandler | undefined>
  )) {
    const verb = rawVerb.toUpperCase();
    if (fn === undefined) {
      excluded.add(verb);
    } else {
      verbMap.set(verb, fn);
    }
  }

  const hasAny = verbMap.has('ANY');
  const allowedSet = new Set<string>();

  if (hasAny) {
    for (const std of STANDARD_METHODS) {
      if (!excluded.has(std)) {
        allowedSet.add(std);
      }
    }
  }

  for (const verb of verbMap.keys()) {
    if (verb !== 'ANY') {
      allowedSet.add(verb);
    }
  }

  if (verbMap.has('GET') && !excluded.has('HEAD')) {
    allowedSet.add('HEAD');
  }

  let handler: THandler | null = verbMap.get(upperMethod) ?? null;

  if (!handler && upperMethod === 'HEAD' && !excluded.has('HEAD')) {
    handler = verbMap.get('GET') ?? null;
  }

  if (!handler && hasAny) {
    handler = verbMap.get('ANY') ?? null;
  }

  return {
    handler,
    allowedMethods: [...allowedSet],
  };
}
