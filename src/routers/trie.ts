import type { endGOHandler, IRouter, RouteMatch } from '../types.js';
import { normalizePath, resolveVerb, splitSegments } from './shared.js';

interface TrieRouteEntry<THandler> {
  path: string;
  payload: THandler | Record<string, THandler | undefined>;
  paramNames: string[];
}

class TrieNode<THandler> {
  readonly children = new Map<string, TrieNode<THandler>>();
  paramChild: TrieNode<THandler> | null = null;
  wildcardChild: TrieNode<THandler> | null = null;
  route: TrieRouteEntry<THandler> | null = null;
}

interface TrieMatchResult<THandler> {
  route: TrieRouteEntry<THandler>;
  capturedParams: string[];
  wildcard: string | null;
}

/**
 * Segment-based Radix / Trie router with O(K) lookup complexity.
 * Priority at each segment level: static > `:param` > `*` wildcard.
 */
export class TrieRouter<THandler = endGOHandler<any>> implements IRouter<THandler> {
  private readonly root = new TrieNode<THandler>();

  /**
   * Registers a path pattern and its handler or verb map.
   */
  public listen(
    path: string,
    payload: THandler | Record<string, THandler | undefined>
  ): void {
    const normalized = normalizePath(path);
    const segments = splitSegments(normalized);
    const paramNames: string[] = [];
    let current = this.root;

    for (const segment of segments) {
      if (segment === '*') {
        if (!current.wildcardChild) {
          current.wildcardChild = new TrieNode<THandler>();
        }
        current = current.wildcardChild;
        break;
      }

      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        if (!current.paramChild) {
          current.paramChild = new TrieNode<THandler>();
        }
        current = current.paramChild;
        continue;
      }

      let child = current.children.get(segment);
      if (!child) {
        child = new TrieNode<THandler>();
        current.children.set(segment, child);
      }
      current = child;
    }

    current.route = {
      path: normalized,
      payload,
      paramNames,
    };
  }

  /**
   * Matches an incoming pathname and HTTP method against registered routes.
   */
  public match(path: string, method: string): RouteMatch<THandler> | null {
    const normalized = normalizePath(path);
    const segments = splitSegments(normalized);
    const capturedParams: string[] = [];

    const hit = this.matchNode(this.root, segments, 0, capturedParams);
    if (!hit) return null;

    const params: Record<string, string> = {};
    for (let i = 0; i < hit.route.paramNames.length; i++) {
      params[hit.route.paramNames[i]] = hit.capturedParams[i];
    }
    if (hit.wildcard !== null) {
      params['*'] = hit.wildcard;
    }

    const { handler, allowedMethods } = resolveVerb(hit.route.payload, method);
    return { handler, params, allowedMethods };
  }

  /**
   * Removes a registered route path and prunes any empty nodes.
   */
  public silence(path: string): boolean {
    const normalized = normalizePath(path);
    const segments = splitSegments(normalized);
    const trail: Array<{
      parent: TrieNode<THandler>;
      kind: 'static' | 'param' | 'wildcard';
      key?: string;
      node: TrieNode<THandler>;
    }> = [];

    let current = this.root;
    for (const segment of segments) {
      if (segment === '*') {
        if (!current.wildcardChild) return false;
        trail.push({
          parent: current,
          kind: 'wildcard',
          node: current.wildcardChild,
        });
        current = current.wildcardChild;
        break;
      }

      if (segment.startsWith(':')) {
        if (!current.paramChild) return false;
        trail.push({
          parent: current,
          kind: 'param',
          node: current.paramChild,
        });
        current = current.paramChild;
        continue;
      }

      const child = current.children.get(segment);
      if (!child) return false;
      trail.push({
        parent: current,
        kind: 'static',
        key: segment,
        node: child,
      });
      current = child;
    }

    if (!current.route) return false;
    current.route = null;

    for (let i = trail.length - 1; i >= 0; i--) {
      const step = trail[i];
      const node = step.node;
      const isEmpty =
        node.route === null &&
        node.children.size === 0 &&
        node.paramChild === null &&
        node.wildcardChild === null;

      if (!isEmpty) break;

      if (step.kind === 'static') {
        step.parent.children.delete(step.key!);
      } else if (step.kind === 'param') {
        step.parent.paramChild = null;
      } else {
        step.parent.wildcardChild = null;
      }
    }

    return true;
  }

  /**
   * Returns all registered normalized route paths.
   */
  public routes(): string[] {
    const list: string[] = [];
    this.collectRoutes(this.root, list);
    return list;
  }

  private matchNode(
    node: TrieNode<THandler>,
    segments: string[],
    index: number,
    capturedParams: string[]
  ): TrieMatchResult<THandler> | null {
    if (index === segments.length) {
      if (node.route) {
        return {
          route: node.route,
          capturedParams: [...capturedParams],
          wildcard: null,
        };
      }
      if (index === 0 && node.wildcardChild?.route) {
        return {
          route: node.wildcardChild.route,
          capturedParams: [...capturedParams],
          wildcard: '',
        };
      }
      return null;
    }

    const segment = segments[index];

    const staticChild = node.children.get(segment);
    if (staticChild) {
      const match = this.matchNode(staticChild, segments, index + 1, capturedParams);
      if (match) return match;
    }

    if (node.paramChild) {
      capturedParams.push(segment);
      const match = this.matchNode(
        node.paramChild,
        segments,
        index + 1,
        capturedParams
      );
      if (match) return match;
      capturedParams.pop();
    }

    if (node.wildcardChild?.route) {
      return {
        route: node.wildcardChild.route,
        capturedParams: [...capturedParams],
        wildcard: segments.slice(index).join('/'),
      };
    }

    return null;
  }

  private collectRoutes(node: TrieNode<THandler>, out: string[]): void {
    if (node.route) {
      out.push(node.route.path);
    }
    for (const child of node.children.values()) {
      this.collectRoutes(child, out);
    }
    if (node.paramChild) {
      this.collectRoutes(node.paramChild, out);
    }
    if (node.wildcardChild) {
      this.collectRoutes(node.wildcardChild, out);
    }
  }
}
