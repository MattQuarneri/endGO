import { serveBun } from './adapters/bun.js';
import { endGOEventBus } from './events.js';
import { composePipeline, matchMiddlewarePattern } from './middleware.js';
import { createReply } from './reply.js';
import { createendGORequest } from './request.js';
import { createInitialRequestor } from './requestor.js';
import { TrieRouter } from './routers/index.js';
import type {
  DefaultEnv,
  endGOConfig,
  endGOEventListener,
  endGOEventName,
  endGOLogger,
  endGOMiddleware,
  endGOOptions,
  ExecutionContext,
  HandlerContext,
  IRouter,
  MiddlewareContext,
  MiddlewareEntry,
  PathResolver,
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

/**
 * Core endGO application class implementing IoC wiring, route/middleware registration,
 * lifecycle events, and the Web Standard `fetch` entrypoint.
 */
export class endGO<
  TEnv extends DefaultEnv = DefaultEnv,
  TRouter extends IRouter<any> = TrieRouter<any>,
  TResolver extends PathResolver = PathResolver
> {
  private readonly baseEnv: TEnv;
  private readonly router: TRouter;
  private readonly resolver?: TResolver;
  private readonly config: Readonly<endGOConfig>;
  private readonly logger: endGOLogger;
  private readonly modules: Record<string, unknown>;
  private readonly services: Record<string, unknown>;
  private readonly cache: Map<string, unknown>;
  private readonly eventBus: endGOEventBus;
  private readonly middlewares: MiddlewareEntry<
    TEnv,
    any,
    any,
    any,
    any,
    any,
    TRouter,
    TResolver
  >[];
  private readonly replyFn: (
    status: number,
    payload?: unknown,
    headers?: Record<string, string>
  ) => Response;

  constructor(options?: endGOOptions<TEnv, TRouter, TResolver>) {
    this.baseEnv = options?.Environment ?? ({} as TEnv);
    this.router = options?.Router ?? (new TrieRouter() as unknown as TRouter);
    this.resolver = options?.Resolver;
    this.config = Object.freeze({ ...(options?.config ?? {}) });
    this.logger = options?.logger ?? defaultConsoleLogger;
    this.modules = options?.modules ?? {};
    this.services = options?.services ?? {};
    this.cache = new Map<string, unknown>();
    this.eventBus = new endGOEventBus();
    this.middlewares = [];
    this.replyFn = createReply(this.config);
  }

  /**
   * Registers a terminal handler or HTTP verb map for the given route path.
   */
  public end(
    path: string,
    handler: RoutePayload<TEnv, any, any, any, any, any, TRouter, TResolver>
  ): this {
    this.router.listen(path, handler as any);
    return this;
  }

  /**
   * Registers global (`'*'`) or pattern-scoped middleware functions.
   */
  public mid(
    patternOrMiddleware:
      | string
      | endGOMiddleware<TEnv, any, any, any, any, any, TRouter, TResolver>,
    ...more: endGOMiddleware<TEnv, any, any, any, any, any, TRouter, TResolver>[]
  ): this {
    if (typeof patternOrMiddleware === 'function') {
      for (const middleware of [patternOrMiddleware, ...more]) {
        this.middlewares.push({ pattern: '*', middleware });
      }
    } else {
      for (const middleware of more) {
        this.middlewares.push({ pattern: patternOrMiddleware, middleware });
      }
    }
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
    try {
      const url = new URL(rawRequest.url);
      const pathname = this.resolver
        ? this.resolver(url.pathname, rawRequest)
        : url.pathname;
      const match = this.router.match(pathname, rawRequest.method);
      const mergedEnv = workerEnv
        ? ({ ...this.baseEnv, ...workerEnv } as TEnv)
        : this.baseEnv;

      const serverContext = this.createServerContext(mergedEnv, ctx);
      const endGORequest = createendGORequest(
        rawRequest,
        match?.params ?? {},
        url
      );
      const initialRequestor = createInitialRequestor(rawRequest);

      const middlewareContext: MiddlewareContext<
        TEnv,
        any,
        any,
        any,
        any,
        any,
        TRouter,
        TResolver
      > = {
        request: endGORequest,
        requestor: initialRequestor,
        server: serverContext,
      };

      const matchingMiddlewares = this.middlewares
        .filter((entry) => matchMiddlewarePattern(entry.pattern, pathname))
        .map((entry) => entry.middleware);

      const response = await composePipeline(
        matchingMiddlewares,
        middlewareContext,
        async () => {
          if (!match) {
            return serverContext.reply(404, {
              error: 'Not Found',
              path: pathname,
            });
          }

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

          const handlerContext: HandlerContext<
            TEnv,
            any,
            any,
            any,
            any,
            any,
            TRouter,
            TResolver
          > = Object.freeze({
            request: middlewareContext.request,
            requestor: Object.freeze({
              ...middlewareContext.requestor,
              roles: Object.freeze([...middlewareContext.requestor.roles]),
              permissions: Object.freeze([
                ...middlewareContext.requestor.permissions,
              ]),
              device: Object.freeze({ ...middlewareContext.requestor.device }),
            }),
            server: middlewareContext.server,
          });

          return match.handler(handlerContext);
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
      return this.replyFn(500, { error: 'Internal Server Error' });
    }
  };

  /**
   * Builds a frozen per-request ServerContext delegating shared app resources
   * while scoping `env` and `ctx` to the active request.
   */
  private createServerContext(
    env: TEnv,
    ctx?: ExecutionContext
  ): ServerContext<TEnv, TRouter, TResolver> {
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
      end: (
        path: string,
        handler: RoutePayload<TEnv, any, any, any, any, any, TRouter, TResolver>
      ) => {
        app.end(path, handler);
      },
      mid: (
        patternOrMiddleware:
          | string
          | endGOMiddleware<TEnv, any, any, any, any, any, TRouter, TResolver>,
        ...more: endGOMiddleware<
          TEnv,
          any,
          any,
          any,
          any,
          any,
          TRouter,
          TResolver
        >[]
      ) => {
        app.mid(patternOrMiddleware, ...more);
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
