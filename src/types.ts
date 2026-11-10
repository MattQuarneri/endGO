/**
 * Minimal Cloudflare Workers / WinterCG execution context interface.
 */
export interface ExecutionContext {
  /** Schedules asynchronous work to outlive the response lifecycle. */
  waitUntil(promise: Promise<unknown>): void;
  /** Optional Cloudflare Workers hook to fall back to origin on unhandled exceptions. */
  passThroughOnException?(): void;
}

/**
 * Callback invoked with a lazily parsed request body value.
 */
export type BodyCallback<T, R> = (value: T) => R | Promise<R>;

/**
 * Lazy-evaluated request body accessors.
 */
export interface ResolvedBody<TJson = unknown, TForm = FormData> {
  /** Reads the body as raw UTF-8 text. */
  literal<R = string | null>(fn?: BodyCallback<string | null, R>): Promise<R>;
  /** Parses the body as JSON. */
  json<T = TJson, R = T | null>(fn?: BodyCallback<T | null, R>): Promise<R>;
  /** Alias for {@link json} returning a parsed object. */
  object<T = TJson, R = T | null>(fn?: BodyCallback<T | null, R>): Promise<R>;
  /** Parses the body as URL-encoded or multipart FormData. */
  form<R = TForm | null>(fn?: BodyCallback<TForm | null, R>): Promise<R>;
  /** Extracts uploaded files from multipart FormData. */
  files<R = Record<string, File | File[]> | null>(
    fn?: BodyCallback<Record<string, File | File[]> | null, R>
  ): Promise<R>;
  /** Reads the body as a binary Blob. */
  blob<R = Blob | null>(fn?: BodyCallback<Blob | null, R>): Promise<R>;
  /** Raw ReadableStream for unbuffered binary consumption. */
  readonly stream: ReadableStream<Uint8Array> | null;
}

/**
 * Lazily resolved metadata and body accessors derived from the native Request.
 */
export interface Resolved<
  TParams = Record<string, string>,
  TQuery = Record<string, string>
> {
  /** Native Web Standard URL instance. */
  readonly url: URL;
  /** Parsed request cookies. */
  readonly cookies: Readonly<Record<string, string>>;
  /** Whether conditional cache headers indicate the client copy is fresh. */
  readonly fresh: boolean;
  /** Best-effort client IP address resolved from forwarding headers. */
  readonly ip: string;
  /** Request protocol (e.g., 'http' or 'https'). */
  readonly protocol: string;
  /** Native Web Standard Headers instance. */
  readonly headers: Headers;
  /** Uppercase HTTP method. */
  readonly method: string;
  /** Route parameters extracted by the active router. */
  readonly params: Readonly<TParams>;
  /** Query string parameters parsed from the URL. */
  readonly query: Readonly<TQuery>;
  /** Accepted media types parsed from the Accept header. */
  readonly accepts: readonly string[];
  /** Convenience accessor for uploaded files from multipart FormData. */
  files<R = Record<string, File | File[]> | null>(
    fn?: BodyCallback<Record<string, File | File[]> | null, R>
  ): Promise<R>;
  /** Lazy body parser interface, or null when no body is present. */
  readonly body: ResolvedBody | null;
}

/**
 * The "What" pillar of the tripartite context: wraps the native Request and lazy resolvers.
 */
export interface endGORequest<
  TParams = Record<string, string>,
  TQuery = Record<string, string>
> {
  /** Unadulterated Web Standard Request object. */
  readonly raw: Request;
  /** Lazily evaluated request metadata and payload accessors. */
  readonly resolved: Resolved<TParams, TQuery>;
}

/**
 * Client device metadata derived from request headers.
 */
export interface DeviceInfo {
  readonly browser?: string;
  readonly os?: string;
  readonly isMobile?: boolean;
  readonly userAgent?: string;
  readonly [key: string]: unknown;
}

/**
 * The "Who" pillar of the tripartite context: immutable snapshot of identity and localization.
 */
export interface Requestor<TUser = unknown, TTenant = unknown, TSession = unknown> {
  readonly user: TUser | null;
  readonly tenant: TTenant | null;
  readonly session: TSession | null;
  readonly token: string | null;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly device: Readonly<DeviceInfo>;
  readonly locale: string;
  readonly timezone: string;
  readonly authProvider: string | null;
}

/**
 * Default environment dictionary type.
 */
export type DefaultEnv = Record<string, unknown>;

/**
 * Structured logger contract injected into ServerContext.
 */
export interface endGOLogger {
  info(msg: string, ...meta: unknown[]): void;
  error(msg: string, ...meta: unknown[]): void;
  warn(msg: string, ...meta: unknown[]): void;
  debug(msg: string, ...meta: unknown[]): void;
}

/**
 * CORS configuration applied by {@link ServerContext.reply} and preflight handling.
 */
export interface endGOCorsConfig {
  origin?: string | string[];
  methods?: string[];
  headers?: string[];
  credentials?: boolean;
  maxAge?: number;
}

/**
 * Framework configuration container.
 */
export interface endGOConfig {
  cors?: endGOCorsConfig;
  [key: string]: unknown;
}

/**
 * Supported framework lifecycle event names.
 */
export type endGOEventName = 'startup' | 'shutdown' | 'error';

/**
 * Callback registered for framework lifecycle events.
 */
export type endGOEventListener = (payload?: unknown) => void | Promise<void>;

/**
 * Execution context passed to middleware.
 * Exposes a mutable `requestor` reference so trusted middleware can swap in a new immutable snapshot.
 */
export interface MiddlewareContext<
  TEnv = DefaultEnv,
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
  TRouter = IRouter<any>,
  TResolver = PathResolver
> {
  readonly request: endGORequest<TParams, TQuery>;
  requestor: Requestor<TUser, TTenant, TSession>;
  readonly server: ServerContext<TEnv, TRouter, TResolver>;
}

/**
 * Execution context passed to terminal endpoint handlers.
 */
export interface HandlerContext<
  TEnv = DefaultEnv,
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
  TRouter = IRouter<any>,
  TResolver = PathResolver
> {
  readonly request: endGORequest<TParams, TQuery>;
  readonly requestor: Requestor<TUser, TTenant, TSession>;
  readonly server: ServerContext<TEnv, TRouter, TResolver>;
}

/**
 * Continuation function invoking the next middleware or terminal handler in the pipeline.
 */
export type NextFunction = () => Promise<Response>;

/**
 * Middleware signature intercepting requests before the terminal handler.
 */
export type endGOMiddleware<
  TEnv = DefaultEnv,
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
  TRouter = IRouter<any>,
  TResolver = PathResolver
> = (
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
  next: NextFunction
) => Response | Promise<Response>;

/**
 * Terminal endpoint handler signature.
 */
export type endGOHandler<
  TEnv = DefaultEnv,
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
  TRouter = IRouter<any>,
  TResolver = PathResolver
> = (
  context: HandlerContext<
    TEnv,
    TParams,
    TQuery,
    TUser,
    TTenant,
    TSession,
    TRouter,
    TResolver
  >
) => Response | Promise<Response>;

/**
 * Standard HTTP verbs plus `ANY` catch-all verb key.
 */
export type HttpVerb =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'
  | 'HEAD'
  | 'ANY';

/**
 * Verb-keyed dictionary of endpoint handlers.
 */
export type endGOActionMap<
  TEnv = DefaultEnv,
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
  TRouter = IRouter<any>,
  TResolver = PathResolver
> = Partial<
  Record<
    HttpVerb,
    endGOHandler<TEnv, TParams, TQuery, TUser, TTenant, TSession, TRouter, TResolver>
  >
> &
  Record<
    string,
    | endGOHandler<TEnv, TParams, TQuery, TUser, TTenant, TSession, TRouter, TResolver>
    | undefined
  >;

/**
 * Payload accepted by `end()` and `router.listen()`.
 */
export type RoutePayload<
  TEnv = DefaultEnv,
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
  TRouter = IRouter<any>,
  TResolver = PathResolver
> =
  | endGOHandler<TEnv, TParams, TQuery, TUser, TTenant, TSession, TRouter, TResolver>
  | endGOActionMap<TEnv, TParams, TQuery, TUser, TTenant, TSession, TRouter, TResolver>;

/**
 * Result returned by {@link IRouter.match}.
 * When `handler` is `null`, the path matched but the HTTP method is disallowed (405).
 */
export interface RouteMatch<THandler = endGOHandler<any>> {
  handler: THandler | null;
  params: Record<string, string>;
  allowedMethods: string[];
}

/**
 * Dependency-injected router contract.
 */
export interface IRouter<THandler = endGOHandler<any>> {
  /** Registers a path pattern with a catch-all handler or verb map. */
  listen(path: string, payload: THandler | Record<string, THandler | undefined>): void;
  /** Matches an incoming pathname and HTTP method against registered routes. */
  match(path: string, method: string): RouteMatch<THandler> | null;
  /** Removes a registered route path; returns true if it existed. */
  silence(path: string): boolean;
  /** Lists all currently registered normalized route paths. */
  routes(): string[];
}

/**
 * Custom URL pathname transformation hook executed before router matching.
 */
export type PathResolver = (path: string, request: Request) => string;

/**
 * Registered middleware entry paired with its target path pattern.
 */
export interface MiddlewareEntry<
  TEnv = DefaultEnv,
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
  TRouter = IRouter<any>,
  TResolver = PathResolver
> {
  pattern: string;
  middleware: endGOMiddleware<
    TEnv,
    TParams,
    TQuery,
    TUser,
    TTenant,
    TSession,
    TRouter,
    TResolver
  >;
}

/**
 * The "Where / How" pillar of the tripartite context: DI container, lifecycle, and helpers.
 */
export interface ServerContext<
  TEnv = DefaultEnv,
  TRouter = IRouter<any>,
  TResolver = PathResolver
> {
  readonly env: TEnv;
  readonly ctx?: ExecutionContext;
  readonly config: Readonly<endGOConfig>;
  readonly logger: endGOLogger;
  readonly router: TRouter;
  readonly resolver?: TResolver;
  readonly modules: Record<string, unknown>;
  readonly services: Record<string, unknown>;
  readonly cache: Map<string, unknown>;
  readonly endpoints: readonly string[];
  readonly middleware: readonly MiddlewareEntry<
    TEnv,
    any,
    any,
    any,
    any,
    any,
    TRouter,
    TResolver
  >[];

  /** Registers an endpoint with a single handler or verb map. */
  end(
    path: string,
    handler: RoutePayload<TEnv, any, any, any, any, any, TRouter, TResolver>
  ): void;

  /** Registers global or pattern-scoped middleware functions. */
  mid(
    patternOrMiddleware:
      | string
      | endGOMiddleware<TEnv, any, any, any, any, any, TRouter, TResolver>,
    ...middlewares: endGOMiddleware<TEnv, any, any, any, any, any, TRouter, TResolver>[]
  ): void;

  /** Dynamically unregisters an endpoint path. */
  silence(endpoint: string): boolean;

  /** Binds the server using the active runtime adapter. */
  listen(
    portOrOptions: number | string | Record<string, unknown>,
    callback?: () => void
  ): unknown;

  /** Subscribes a listener to a framework lifecycle event. */
  on(event: endGOEventName, callback: endGOEventListener): void;

  /** Emits a framework lifecycle event to registered listeners. */
  emit(event: endGOEventName, payload?: unknown): Promise<void>;

  /** Builds a standardized Web Response with JSON serialization and CORS headers. */
  reply(
    status: number,
    payload?: unknown,
    headers?: Record<string, string>
  ): Response;
}

/**
 * IoC initialization options for the endGO application instance.
 */
export interface endGOOptions<
  TEnv = DefaultEnv,
  TRouter extends IRouter<any> = IRouter<any>,
  TResolver extends PathResolver = PathResolver
> {
  Environment?: TEnv;
  Router?: TRouter;
  Resolver?: TResolver;
  config?: endGOConfig;
  logger?: endGOLogger;
  modules?: Record<string, unknown>;
  services?: Record<string, unknown>;
}
