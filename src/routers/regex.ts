import type { endGOHandler, IRouter, RouteMatch } from '../types.js';
import { normalizePath, resolveVerb, splitSegments } from './shared.js';

interface RegExRouteEntry<THandler> {
  pattern: RegExp;
  paramNames: string[];
  payload: THandler | Record<string, THandler | undefined>;
}

const REGEX_META_CHARS = /[.*+?^${}()|[\]\\]/g;

/**
 * Compiles a normalized path into a regular expression and ordered parameter names.
 */
function compilePattern(normalizedPath: string): {
  pattern: RegExp;
  paramNames: string[];
} {
  if (normalizedPath === '/') {
    return { pattern: /^\/$/, paramNames: [] };
  }

  const segments = splitSegments(normalizedPath);
  const paramNames: string[] = [];
  const parts: string[] = [];

  for (const segment of segments) {
    if (segment === '*') {
      paramNames.push('*');
      parts.push('(.*)');
      break;
    }

    if (segment.startsWith(':')) {
      paramNames.push(segment.slice(1));
      parts.push('([^/]+)');
      continue;
    }

    parts.push(segment.replace(REGEX_META_CHARS, '\\$&'));
  }

  return {
    pattern: new RegExp(`^/${parts.join('/')}$`),
    paramNames,
  };
}

/**
 * Regular-expression based router evaluating registered patterns in insertion order.
 */
export class RegExRouter<THandler = endGOHandler<any>> implements IRouter<THandler> {
  private readonly entries = new Map<string, RegExRouteEntry<THandler>>();

  /**
   * Registers a path pattern and its handler or verb map.
   */
  public listen(
    path: string,
    payload: THandler | Record<string, THandler | undefined>
  ): void {
    const normalized = normalizePath(path);
    const { pattern, paramNames } = compilePattern(normalized);

    this.entries.set(normalized, {
      pattern,
      paramNames,
      payload,
    });
  }

  /**
   * Matches an incoming pathname and HTTP method against registered patterns.
   */
  public match(path: string, method: string): RouteMatch<THandler> | null {
    const normalized = normalizePath(path);

    for (const entry of this.entries.values()) {
      const exec = entry.pattern.exec(normalized);
      if (!exec) continue;

      const params: Record<string, string> = {};
      for (let i = 0; i < entry.paramNames.length; i++) {
        params[entry.paramNames[i]] = exec[i + 1] ?? '';
      }

      const { handler, allowedMethods } = resolveVerb(entry.payload, method);
      return { handler, params, allowedMethods };
    }

    return null;
  }

  /**
   * Removes a registered route path.
   */
  public silence(path: string): boolean {
    return this.entries.delete(normalizePath(path));
  }

  /**
   * Returns all registered normalized route paths.
   */
  public routes(): string[] {
    return [...this.entries.keys()];
  }
}
