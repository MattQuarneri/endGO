import { serveBun } from './adapters/bun.js';
import type { EndpointModule } from './endpoint.js';
import { endGOEventBus } from './events.js';
import { composePipeline, matchMiddlewarePattern } from './middleware.js';
import { createReply } from './reply.js';
import { createendGORequest } from './request.js';
import { createInitialRequestor } from './requestor.js';
import { joinPaths, normalizePath, TrieRouter } from './routers/index.js';
import type {
  DefaultEnv,
  endGOConfig,
  endGOEventListener,
  endGOEventName,
  endGOLogger,
  endGOMiddleware,
  endGOOptions,
  ErrorHandler,
  ExecutionContext,
  ExtractParams,
  HandlerContext,
  IRouter,
  MiddlewareContext,
  MiddlewareEntry,
  MountHandler,
  NotFoundHandler,
  PathResolver,
  ReplyHeaders,
  RoutePayload,
  ServerContext,
} from './types.js';

/**
 * Default structured console logger used when no custom logger is injected.
 */
const defaultConsoleLogger: endGOLogger = {
  info: (msg: string, ...meta: unknown[]) => console.info(msg, ...meta),
  error: (msg: string, ...meta: unknown[]) => console.error(msg, ...meta),
  warn: (msg: string, ...meta: unknown[]) => console.warn(msg, ...meta),
  debug: (msg: string, ...meta: unknown[]) => console.debug(msg, ...meta),
};

interface MountEntry {
  prefix: string;
  handler: MountHandler;
}

function normalizeMountPrefix(prefix: string): string {
  const withoutWildcard = prefix.endsWith('/*')
    ? prefix.slice(0, -2) || '/'
    : prefix;
  return normalizePath(withoutWildcard);
}

function groupMiddlewarePattern(normalizedPrefix: string): string {
  return normalizedPrefix === '/' ? '*' : `${normalizedPrefix}/*`;
}

function freezeHandlerContext<
  TEnv,
  TParams,
  TQuery,
  TUser,
  TTenant,
  TSession,
  TServices,
  TRouter,
  TResolver
>(
  middlewareContext: MiddlewareContext<
    TEnv,
    TParams,
    TQuery,
    TUser,
    TTenant,
    TSession,
    TServices,
    TRouter,
    TResolver
  >
): HandlerContext<
  TEnv,
  TParams,
  TQuery,
  TUser,
  TTenant,
  TSession,
  TServices,
  TRouter,
  TResolver
> {
  return Object.freeze({
    request: middlewareContext.request,
    requestor: Object.freeze({
      ...middlewareContext.requestor,
      roles: Object.freeze([...middlewareContext.requestor.roles]),
      permissions: Object.freeze([...middlewareContext.requestor.permissions]),
      device: Object.freeze({ ...middlewareContext.requestor.device }),
    }),
    server: middlewareContext.server,
  });
}

/**
 * Scoped route group builder returned by {@link endGO.group}.
 * Automatically prefixes registered routes, middleware, mounts, and endpoints.
 */
export class RouteGroup<
  TPrefix extends string = string,
  TEnv = DefaultEnv,
  TServices = Record<string, unknown>,
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
  TRouter extends IRouter<any> = TrieRouter<any>,
  TResolver extends PathResolver = PathResolver
> {
  private readonly app: endGO<
    TEnv,
    TServices,
    TUser,
    TTenant,
    TSession,
    TRouter,
    TResolver
  >;
  private readonly prefix: string;

  constructor(
    app: endGO<TEnv, TServices, TUser, TTenant, TSession, TRouter, TResolver>,
    prefix: TPrefix
  ) {
    this.app = app;
    this.prefix = normalizePath(prefix);
  }

  /**
   * Registers a terminal handler or verb map under this group's prefix.
   */
  public end<TPath extends string>(
    path: TPath,
    handler: RoutePayload<
      TEnv,
      ExtractParams<`${TPrefix}${TPath}`>,
      Record<string, string>,
      TUser,
      TTenant,
      TSession,
      TServices,
      TRouter,
      TResolver
    >
  ): this {
    this.app.end(joinPaths(this.prefix, path), handler as any);
    return this;
  }

  /**
   * Registers middleware scoped to this group (or a sub-pattern within it).
   */
  public mid<TPath extends string = string>(
    patternOrMiddleware:
      | TPath
      | endGOMiddleware<
          TEnv,
          ExtractParams<TPrefix>,
          Record<string, string>,
          TUser,
          TTenant,
          TSession,
          TServices,
          TRouter,
          TResolver
        >,
    ...more: endGOMiddleware<
      TEnv,
      ExtractParams<`${TPrefix}${TPath}`>,
      Record<string, string>,
      TUser,
      TTenant,
      TSession,
      TServices,
      TRouter,
      TResolver
    >[]
  ): this {
    if (typeof patternOrMiddleware === 'function') {
      this.app.mid(
        groupMiddlewarePattern(this.prefix),
        patternOrMiddleware as any,
        ...(more as any[])
      );
    } else {
      const scopedPattern =
        patternOrMiddleware === '*'
          ? groupMiddlewarePattern(this.prefix)
          : joinPaths(this.prefix, patternOrMiddleware);
      this.app.mid(scopedPattern, ...(more as any[]));
    }
    return this;
  }

  /**
   * Creates a nested route group beneath this group's prefix.
   */
  public group<TSubPrefix extends string>(
    subPrefix: TSubPrefix,
    ...middlewares: endGOMiddleware<
      TEnv,
      ExtractParams<`${TPrefix}${TSubPrefix}`>,
      Record<string, string>,
      TUser,
      TTenant,
      TSession,
      TServices,
      TRouter,
      TResolver
    >[]
  ): RouteGroup<
    `${TPrefix}${TSubPrefix}`,
    TEnv,
    TServices,
    TUser,
    TTenant,
    TSession,
    TRouter,
    TResolver
  > {
    const combinedPrefix = joinPaths(this.prefix, subPrefix) as `${TPrefix}${TSubPrefix}`;
    return this.app.group(combinedPrefix, ...(middlewares as any[]));
  }

  /**
   * Mounts a sub-application or fetch handler beneath this group's prefix.
   */
  public mount(prefix: string, handler: MountHandler): this {
    const combined = joinPaths(this.prefix, normalizeMountPrefix(prefix));
    this.app.mount(combined, handler);
    return this;
  }

  /**
   * Registers a composable endpoint module beneath this group's prefix.
   */
  public register<TPath extends string>(
    endpoint: EndpointModule<
      TPath,
      TEnv,
      TServices,
      TUser,
      TTenant,
      TSession,
      TRouter,
      TResolver
    >
  ): this {
    const fullPath = joinPaths(this.prefix, endpoint.path);
    if (endpoint.middleware.length > 0) {
      this.app.mid(fullPath, ...(endpoint.middleware as any[]));
    }
    this.app.end(fullPath, endpoint.payload as any);
    return this;
  }
}

/**
 * Core endGO application class implementing IoC wiring, route/middleware registration,
 * lifecycle events, and the Web Standard `fetch` entrypoint.
 */
export class endGO<
  TEnv = DefaultEnv,
  TServices = Record<string, unknown>,
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
  TRouter extends IRouter<any> = TrieRouter<any>,
  TResolver extends PathResolver = PathResolver
> {
  private readonly baseEnv: TEnv;
  private readonly router: TRouter;
  private readonly resolver?: TResolver;
  private readonly config: Readonly<endGOConfig>;
  private readonly logger: endGOLogger;
  private readonly modules: Record<string, unknown>;
  private readonly services: TServices;
  private readonly cache: Map<string, unknown>;
  private readonly eventBus: endGOEventBus;
  private readonly middlewares: MiddlewareEntry<
    TEnv,
    any,
    any,
    TUser,
    TTenant,
    TSession,
    TServices,
    TRouter,
    TResolver
  >[];
  private readonly mounts: MountEntry[];
  private notFoundHandler?: NotFoundHandler<
    TEnv,
    TServices,
    TUser,
    TTenant,
    TSession,
    TRouter,
    TResolver
  >;
  private errorHandler?: ErrorHandler<
    TEnv,
    TServices,
    TUser,
    TTenant,
    TSession,
    TRouter,
    TResolver
  >;
  private readonly replyFn: (
    status: number,
    payload?: unknown,
    headers?: ReplyHeaders
  ) => Response;

  constructor(
    options?: endGOOptions<
      TEnv,
      TServices,
      TUser,
      TTenant,
      TSession,
      TRouter,
      TResolver
    >
  ) {
    this.baseEnv = options?.Environment ?? ({} as TEnv);
    this.router = options?.Router ?? (new TrieRouter() as unknown as TRouter);
    this.resolver = options?.Resolver;
    this.config = Object.freeze({ ...(options?.config ?? {}) });
    this.logger = options?.logger ?? defaultConsoleLogger;
    this.modules = options?.modules ?? {};
    this.services = options?.services ?? ({} as TServices);
    this.cache = new Map<string, unknown>();
    this.eventBus = new endGOEventBus();
    this.middlewares = [];
    this.mounts = [];
    this.notFoundHandler = options?.onNotFound;
    this.errorHandler = options?.onError;
    this.replyFn = createReply(this.config);
  }

  /**
   * Registers a terminal handler or HTTP verb map for the given route path.
   */
  public end<TPath extends string>(
    path: TPath,
    handler: RoutePayload<
      TEnv,
      ExtractParams<TPath>,
      Record<string, string>,
      TUser,
      TTenant,
      TSession,
      TServices,
      TRouter,
      TResolver
    >
  ): this {
    this.router.listen(path, handler as any);
    return this;
  }

  /**
   * Registers global (`'*'`) or pattern-scoped middleware functions.
   */
  public mid<TPath extends string = string>(
    patternOrMiddleware:
      | TPath
      | endGOMiddleware<
          TEnv,
          Record<string, string>,
          Record<string, string>,
          TUser,
          TTenant,
          TSession,
          TServices,
          TRouter,
          TResolver
        >,
    ...more: endGOMiddleware<
      TEnv,
      ExtractParams<TPath>,
      Record<string, string>,
      TUser,
      TTenant,
      TSession,
      TServices,
      TRouter,
      TResolver
    >[]
  ): this {
    if (typeof patternOrMiddleware === 'function') {
      for (const middleware of [patternOrMiddleware, ...more]) {
        this.middlewares.push({ pattern: '*', middleware: middleware as any });
      }
    } else {
      for (const middleware of more) {
        this.middlewares.push({
          pattern: patternOrMiddleware,
          middleware: middleware as any,
        });
      }
    }
    return this;
  }

  /**
   * Registers a custom 404 Not Found handler.
   */
  public notFound(
    handler: NotFoundHandler<
      TEnv,
      TServices,
      TUser,
      TTenant,
      TSession,
      TRouter,
      TResolver
    >
  ): this {
    this.notFoundHandler = handler;
    return this;
  }

  /**
   * Registers a custom error handler invoked when middleware or handlers throw.
   */
  public onError(
    handler: ErrorHandler<
      TEnv,
      TServices,
      TUser,
      TTenant,
      TSession,
      TRouter,
      TResolver
    >
  ): this {
    this.errorHandler = handler;
    return this;
  }

  /**
   * Mounts a sub-application or Web Standard fetch handler at the given path prefix.
   * Strips the matched prefix before forwarding the `Request`.
   */
  public mount(prefix: string, handler: MountHandler): this {
    const normalizedPrefix = normalizeMountPrefix(prefix);
    const existingIndex = this.mounts.findIndex(
      (entry) => entry.prefix === normalizedPrefix
    );
    if (existingIndex >= 0) {
      this.mounts[existingIndex] = { prefix: normalizedPrefix, handler };
    } else {
      this.mounts.push({ prefix: normalizedPrefix, handler });
      this.mounts.sort((a, b) => b.prefix.length - a.prefix.length);
    }
    return this;
  }

  /**
   * Creates a scoped route group sharing a path prefix and optional middleware.
   */
  public group<TPrefix extends string>(
    prefix: TPrefix,
    ...middlewares: endGOMiddleware<
      TEnv,
      ExtractParams<TPrefix>,
      Record<string, string>,
      TUser,
      TTenant,
      TSession,
      TServices,
      TRouter,
      TResolver
    >[]
  ): RouteGroup<
    TPrefix,
    TEnv,
    TServices,
    TUser,
    TTenant,
    TSession,
    TRouter,
    TResolver
  > {
    if (middlewares.length > 0) {
      const normalizedPrefix = normalizePath(prefix);
      this.mid(groupMiddlewarePattern(normalizedPrefix), ...(middlewares as any[]));
    }
    return new RouteGroup(this, prefix);
  }

  /**
   * Registers a composable endpoint module (including its scoped middleware and verb map).
   */
  public register<TPath extends string>(
    endpoint: EndpointModule<
      TPath,
      TEnv,
      TServices,
      TUser,
      TTenant,
      TSession,
      TRouter,
      TResolver
    >
  ): this {
    if (endpoint.middleware.length > 0) {
      this.mid(endpoint.path, ...(endpoint.middleware as any[]));
    }
    this.end(endpoint.path, endpoint.payload as any);
    return this;
  }

  /**
   * Dynamically removes a registered route path from the active router.
   */
  public silence(path: string): boolean {
    return this.router.silence(path);
  }

  /**
   * Subscribes a listener to a framework lifecycle event.
   */
  public on(event: endGOEventName, callback: endGOEventListener): this {
    this.eventBus.on(event, callback);
    return this;
  }

  /**
   * Emits a framework lifecycle event sequentially to all registered listeners.
   */
  public emit(event: endGOEventName, payload?: unknown): Promise<void> {
    return this.eventBus.emit(event, payload);
  }

  /**
   * Starts the server when running in Bun; otherwise directs callers to the
   * appropriate runtime entrypoint (`app.fetch` or `serveNode`).
   */
  public listen(
    portOrOptions: number | string | Record<string, unknown>,
    callback?: () => void
  ): unknown {
    if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
      return serveBun(this, portOrOptions, callback);
    }

    throw new Error(
      'endGO.listen() requires the Bun runtime. Use `export default app` (app.fetch) for Cloudflare Workers/Deno, or `serveNode(app, options)` from "endGO/adapters/node" for Node.js.'
    );
  }

  /**
   * Web Standard fetch entrypoint. Defined as an arrow property so `export default app`
   * preserves `this` binding in Cloudflare Workers and similar runtimes.
   */
  public readonly fetch = async (
    rawRequest: Request,
    workerEnv?: Partial<TEnv>,
    ctx?: ExecutionContext
  ): Promise<Response> => {
    let middlewareContext:
      | MiddlewareContext<
          TEnv,
          any,
          any,
          TUser,
          TTenant,
          TSession,
          TServices,
          TRouter,
          TResolver
        >
      | undefined;

    const mergedEnv = workerEnv
      ? ({ ...this.baseEnv, ...workerEnv } as TEnv)
      : this.baseEnv;

    try {
      const url = new URL(rawRequest.url);
      const pathname = this.resolver
        ? this.resolver(url.pathname, rawRequest)
        : url.pathname;
      const match = this.router.match(pathname, rawRequest.method);

      const serverContext = this.createServerContext(mergedEnv, ctx);
      const endGORequest = createendGORequest(
        rawRequest,
        match?.params ?? {},
        url
      );
      const initialRequestor = createInitialRequestor(rawRequest) as any;

      middlewareContext = {
        request: endGORequest,
        requestor: initialRequestor,
        server: serverContext,
      };

      const matchingMiddlewares = this.middlewares
        .filter((entry) => matchMiddlewarePattern(entry.pattern, pathname))
        .map((entry) => entry.middleware);

      const activeContext = middlewareContext;

      const response = await composePipeline(
        matchingMiddlewares,
        activeContext,
        async () => {
          if (match) {
            if (match.handler === null) {
              return serverContext.reply(
                405,
                {
                  error: 'Method Not Allowed',
                  method: rawRequest.method,
                  allowed: match.allowedMethods,
                },
                { Allow: match.allowedMethods.join(', ') }
              );
            }

            const handlerContext = freezeHandlerContext(activeContext);
            return match.handler(handlerContext);
          }

          const mountHit = this.matchMount(pathname);
          if (mountHit) {
            const strippedPath =
              mountHit.prefix === '/'
                ? pathname
                : pathname.slice(mountHit.prefix.length) || '/';

            let mountedRequest = rawRequest;
            if (mountHit.prefix !== '/') {
              const targetUrl = new URL(rawRequest.url);
              targetUrl.pathname = strippedPath;
              mountedRequest = new Request(targetUrl.toString(), rawRequest);
            }

            return typeof mountHit.handler === 'function'
              ? mountHit.handler(mountedRequest, mergedEnv, ctx)
              : mountHit.handler.fetch(mountedRequest, mergedEnv, ctx);
          }

          if (this.notFoundHandler) {
            const handlerContext = freezeHandlerContext(activeContext);
            return this.notFoundHandler(handlerContext);
          }

          return serverContext.reply(404, {
            error: 'Not Found',
            path: pathname,
          });
        }
      );

      if (rawRequest.method.toUpperCase() === 'HEAD' && response.body !== null) {
        return new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      return response;
    } catch (err) {
      this.logger.error('Unhandled error during request lifecycle', err);
      try {
        await this.eventBus.emit('error', err);
      } catch (listenerErr) {
        this.logger.error('Error listener threw an exception', listenerErr);
      }

      if (this.errorHandler) {
        try {
          const fallbackContext = middlewareContext
            ? freezeHandlerContext(middlewareContext)
            : Object.freeze({
                request: createendGORequest(rawRequest, {}),
                requestor: createInitialRequestor(rawRequest) as any,
                server: this.createServerContext(mergedEnv, ctx),
              });
          return await this.errorHandler(err, fallbackContext);
        } catch (handlerErr) {
          this.logger.error('Custom error handler threw an exception', handlerErr);
        }
      }

      return this.replyFn(500, { error: 'Internal Server Error' });
    }
  };

  private matchMount(pathname: string): MountEntry | null {
    if (this.mounts.length === 0) return null;
    const normalized = normalizePath(pathname);

    for (const entry of this.mounts) {
      if (entry.prefix === '/') {
        return entry;
      }
      if (
        normalized === entry.prefix ||
        normalized.startsWith(`${entry.prefix}/`)
      ) {
        return entry;
      }
    }

    return null;
  }

  /**
   * Builds a frozen per-request ServerContext delegating shared app resources
   * while scoping `env` and `ctx` to the active request.
   */
  private createServerContext(
    env: TEnv,
    ctx?: ExecutionContext
  ): ServerContext<TEnv, TServices, TRouter, TResolver> {
    const app = this;
    return Object.freeze({
      env,
      ctx,
      config: this.config,
      logger: this.logger,
      router: this.router,
      resolver: this.resolver,
      modules: this.modules,
      services: this.services,
      cache: this.cache,
      get endpoints(): readonly string[] {
        return Object.freeze(app.router.routes());
      },
      get middleware() {
        return Object.freeze([...app.middlewares]);
      },
      end: <TPath extends string>(
        path: TPath,
        handler: RoutePayload<
          TEnv,
          ExtractParams<TPath>,
          Record<string, string>,
          any,
          any,
          any,
          TServices,
          TRouter,
          TResolver
        >
      ) => {
        app.end(path, handler as any);
      },
      mid: (
        patternOrMiddleware:
          | string
          | endGOMiddleware<TEnv, any, any, any, any, any, TServices, TRouter, TResolver>,
        ...more: endGOMiddleware<
          TEnv,
          any,
          any,
          any,
          any,
          any,
          TServices,
          TRouter,
          TResolver
        >[]
      ) => {
        app.mid(patternOrMiddleware, ...(more as any[]));
      },
      silence: (endpoint: string) => app.silence(endpoint),
      listen: (
        portOrOptions: number | string | Record<string, unknown>,
        callback?: () => void
      ) => app.listen(portOrOptions, callback),
      on: (event: endGOEventName, callback: endGOEventListener) => {
        app.on(event, callback);
      },
      emit: (event: endGOEventName, payload?: unknown) =>
        app.emit(event, payload),
      reply: this.replyFn,
    });
  }
}
