To support Dependency Injection for the Router in EndGo, the core system must rely on an abstract `IRouter` interface. This ensures that EndGo never cares *how* paths are matched—only that a path and an HTTP method go in, and a specific handler and extracted parameters come out.

Here are the TypeScript interfaces defining this contract, along with the structural skeletons for the `RegExRouter` and `TrieRouter` implementations.

### 1. Handler & Match Types

Before defining the router, we must define the shapes of the handlers it will store and return.

```typescript
/**
 * The standard Tripartite EndGo handler signature.
 */
export type EndGoHandler<Req, Reqstr, Srv> = (
  request: Req,
  requestor: Reqstr,
  server: Srv
) => Promise<Response | any> | Response | any;

/**
 * A dictionary of HTTP verbs mapped to specific handlers.
 */
export type EngGoActionHandler<Req, Reqstr, Srv> = {
  GET?: EndGoHandler<Req, Reqstr, Srv>;
  POST?: EndGoHandler<Req, Reqstr, Srv>;
  PUT?: EndGoHandler<Req, Reqstr, Srv>;
  PATCH?: EndGoHandler<Req, Reqstr, Srv>;
  DELETE?: EndGoHandler<Req, Reqstr, Srv>;
  OPTIONS?: EndGoHandler<Req, Reqstr, Srv>;
  HEAD?: EndGoHandler<Req, Reqstr, Srv>;
  // Fallback for custom verbs or ANY
  [verb: string]: EndGoHandler<Req, Reqstr, Srv> | undefined; 
};

/**
 * The payload accepted by app.end() and passed to the Router.
 */
export type RoutePayload<Req, Reqstr, Srv> = 
  | EndGoHandler<Req, Reqstr, Srv> 
  | EngGoActionHandler<Req, Reqstr, Srv>;

/**
 * The exact resolved result the Router must yield to the EndGo engine.
 * Notice it resolves down to a single Handler, handling the verb logic internally.
 */
export interface RouteMatch<Req, Reqstr, Srv> {
  handler: EndGoHandler<Req, Reqstr, Srv> | EndGoActionHandler<Req, Reqstr, Srv>;
  params: Record<string, string>;
}

```

### 2. The Base Router Interface (DI Contract)

This is the interface that `EndGo` will expect via its `<Router>` generic. Any router injected into EndGo must satisfy this contract.
There is no two step `register` + `activate` process. Upon calling `listen` the route is immediately available for matching. 
This simplifies the router lifecycle and aligns with the real-time nature of HTTP request handling.
Therefore, before sending 

```typescript
export interface IRouter<Req, Reqstr, Srv> {
  /**
   * Registers a path and its associated handler.
   * @param path The URL pattern (e.g., '/api/users/:id')
   * @param handler The catch-all function or verb-mapped object
   */
  listen(path: string, handler: RoutePayload<Req, Reqstr, Srv>): void;

  /**
   * Matches a pathname and HTTP method against registered routes.
   * @param path The incoming requested pathname (e.g., '/api/users/123')
   * @param method The incoming HTTP method (e.g., 'POST')
   * @returns The resolved handler and extracted params, or null if no match.
   */
  match(path: string, method: string): RouteMatch<Req, Reqstr, Srv> | null;

  /**
   * Unregisters a path from the routing table.
   * Required to support the `server.silence(endpoint)` API.
   * @param path The URL pattern to remove
   * @returns True if removed, false if not found.
   */
  silence(path: string): boolean;
}

```

---

### 3. RegExRouter Implementation Skeleton

The `RegExRouter` transforms parameterized paths into Regular Expressions (e.g., `/api/users/:id` becomes `/^\/api\/users\/(?<id>[^\/]+)\/?$/`). It is highly flexible for complex path validations but scales linearly ($O(N)$), slowing down as route count grows.

```typescript
interface RegExRouteEntry<Req, Reqstr, Srv> {
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler<Req, Reqstr, Srv>;
}

export class RegExRouter<Req, Reqstr, Srv> implements IRouter<Req, Reqstr, Srv> {
  private routes: Map<string, RegExRouteEntry<Req, Reqstr, Srv>> = new Map();

  public listen(path: string, handler: RouteHandler<Req, Reqstr, Srv>): void {
    const paramNames: string[] = [];
    // Convert path to regex (e.g., replacing :param with capturing groups)
    const regexString = path.replace(/:([^\/]+)/g, (_, paramName) => {
      paramNames.push(paramName);
      return '([^/]+)';
    });
    
    this.routes.set(path, {
      pattern: new RegExp(`^${regexString}$`),
      paramNames,
      handler
    });
  }

  public match(path: string, method: string): RouteMatch<Req, Reqstr, Srv> | null {
    for (const [_, entry] of this.routes) {
      const match = entry.pattern.exec(path);
      if (match) {
        // Extract params based on capturing groups
        const params: Record<string, string> = {};
        entry.paramNames.forEach((name, i) => {
          params[name] = match[i + 1];
        });

        const handler = this.resolveVerb(entry.handler, method);
        if (handler) return { handler, params };
      }
    }
    return null;
  }

  public silence(path: string): boolean {
    return this.routes.delete(path);
  }

  private resolveVerb(handler: RouteHandler<Req, Reqstr, Srv>, method: string): EndGoHandler<Req, Reqstr, Srv> | null {
    if (typeof handler === 'function') return handler;
    return handler[method] || handler['ANY'] || null;
  }
}

```

---

### 4. TrieRouter Implementation Skeleton

The `TrieRouter` (Radix Tree) splits paths into segments (`/`, `api`, `users`, `:id`) and builds a node tree. It is highly memory efficient and routes at $O(K)$ time complexity (where $K$ is the number of path segments), making it vastly superior for large-scale microservice deployments.

```typescript
class TrieNode<Req, Reqstr, Srv> {
  children: Map<string, TrieNode<Req, Reqstr, Srv>> = new Map();
  paramChild: TrieNode<Req, Reqstr, Srv> | null = null;
  paramName: string | null = null;
  handler: RouteHandler<Req, Reqstr, Srv> | null = null;
}

export class TrieRouter<Req, Reqstr, Srv> implements IRouter<Req, Reqstr, Srv> {
  private root = new TrieNode<Req, Reqstr, Srv>();

  public listen(path: string, handler: RouteHandler<Req, Reqstr, Srv>): void {
    const segments = path.split('/').filter(Boolean);
    let current = this.root;

    for (const segment of segments) {
      if (segment.startsWith(':')) {
        if (!current.paramChild) {
          current.paramChild = new TrieNode();
          current.paramName = segment.slice(1);
        }
        current = current.paramChild;
      } else {
        if (!current.children.has(segment)) {
          current.children.set(segment, new TrieNode());
        }
        current = current.children.get(segment)!;
      }
    }
    current.handler = handler;
  }

  public match(path: string, method: string): RouteMatch<Req, Reqstr, Srv> | null {
    const segments = path.split('/').filter(Boolean);
    let current = this.root;
    const params: Record<string, string> = {};

    for (const segment of segments) {
      if (current.children.has(segment)) {
        current = current.children.get(segment)!;
      } else if (current.paramChild) {
        params[current.paramName!] = segment;
        current = current.paramChild;
      } else {
        return null; // Route not found
      }
    }

    if (!current.handler) return null;

    const handler = this.resolveVerb(current.handler, method);
    if (!handler) return null;

    return { handler, params };
  }

  public silence(path: string): boolean {
    // Requires tree traversal to nullify the payload at the leaf node
    // ...implementation omitted for brevity...
    return true; 
  }

  private resolveVerb(handler: RouteHandler<Req, Reqstr, Srv>, method: string): EndGoHandler<Req, Reqstr, Srv> | null {
    if (typeof handler === 'function') return handler;
    return handler[method] || handler['ANY'] || null;
  }
}

```