// ============================================================================
// 1. HELPER TYPES & NATIVE OVERRIDES
// ============================================================================

/** 
 * Represents a lazy-evaluated property that requires asynchronous parsing 
 * (e.g., streaming the Request body into JSON or Form Data).
 */
type LazyAsync<T> = Promise<T>;

/**
 * Standard Web API extensions.
 */
type NativeRequest = globalThis.Request;
type NativeResponse = globalThis.Response;

// ============================================================================
// 2. THE REQUEST CONTEXT (The "What")
// ============================================================================

export interface ResolvedBody<TJson = unknown, TForm = FormData> {
  /** The raw string literal of the body. Lazy-evaluated on access. */
  readonly literal: LazyAsync<string> | string;
  
  /** Parsed form data. Lazy-evaluated on access. Null if not a form request. */
  readonly form: LazyAsync<TForm> | TForm | null;
  
  /** Parsed JSON. Lazy-evaluated on access. Null if not a JSON request. */
  readonly json: LazyAsync<TJson> | TJson | null;
  
  /** Instance of the body.json. Null if not available. */
  readonly object: TJson | null;
  
  /** For large binary payloads, exposes the raw stream. */
  readonly stream: ReadableStream<Uint8Array> | null;
  
  /** For file uploads/binary processing. */
  readonly blob: LazyAsync<Blob> | Blob | null;
}

export interface Resolved<TParams = Record<string, string>, TQuery = Record<string, string>> {
  /** Native URL object for free, standard parsing of path/host/search. */
  readonly url: URL;
  readonly cookies: Record<string, string>;
  readonly fresh: boolean;
  readonly ip: string;
  readonly protocol: 'http' | 'https' | string;
  readonly headers: Headers;
  readonly method: string;
  
  /** URL parameters extracted by the router (e.g., /users/:id -> { id: "1" }) */
  readonly params: TParams;
  
  /** Query parameters parsed from the URL (e.g., ?sort=asc) */
  readonly query: TQuery;
  
  /** Array of accepted content types from the Accept header. */
  readonly accepts: string[];
  
  /** Extracted files from multipart/form-data. */
  readonly files: Record<string, File | File[]> | null;
  
  /** The lazy-evaluated body object. Null if no body is present. */
  readonly body: ResolvedBody | null;
}

export interface TaskimaticRequest<TParams = unknown, TQuery = unknown> {
  /** The unadulterated native request object. */
  readonly raw: NativeRequest;
  
  /** The lazily-resolved request context. */
  readonly resolved: Resolved<TParams, TQuery>;
}

// ============================================================================
// 3. THE REQUESTOR CONTEXT (The "Who")
// ============================================================================

export interface Requestor<TUser = unknown, TSession = unknown> {
  readonly user: TUser | null;
  readonly session: TSession | null;
  readonly token: string | null;
  
  /** The roles associated with the authenticated user. */
  readonly roles: string[];
  
  /** The granular permissions associated with the authenticated user. */
  readonly permissions: string[];
  
  /** Details about the machine making the request (e.g., User-Agent parsing). */
  readonly device: {
    browser?: string;
    os?: string;
    isMobile?: boolean;
    [key: string]: unknown;
  };
  
  /** Identifies the workspace or organization context for multi-tenant apps. */
  readonly tenant: string | null;
  
  /** Locales for localization (e.g., 'en-US'). */
  readonly locale: string;
  
  /** The timezone of the requestor (e.g., 'America/Los_Angeles'). */
  readonly timezone: string;
  
  /** How the session was authenticated (e.g., 'local', 'google', 'saml'). */
  readonly authProvider: string | null;
}

// ============================================================================
// 4. THE SERVER CONTEXT (The "Where / How")
// ============================================================================

/** 
 * Represents the base environment variables and config payload.
 */
export type DefaultEnv = Record<string, unknown>;

export interface ServerContext<TEnv = DefaultEnv, TRouter = unknown, TResolver = unknown> {
  readonly env: TEnv;
  readonly config: Record<string, unknown>;
  readonly logger: {
    info(msg: string, ...meta: any[]): void;
    error(msg: string, ...meta: any[]): void;
    warn(msg: string, ...meta: any[]): void;
    debug(msg: string, ...meta: any[]): void;
  };
  
  /** The dependency-injected router (e.g., TrieRouter or RegexRouter). */
  readonly router: TRouter;
  
  /** The custom resolver logic for URL paths, if provided. */
  readonly resolver?: TResolver;
  
  /** Lazy-loaded modules or components. */
  readonly modules: Record<string, unknown>;
  
  /** External services available to the server (e.g., DB connections, Stripe). */
  readonly services: Record<string, unknown>;
  
  /** Shared in-memory key-value store for handlers (rate limiting, caching). */
  readonly cache: Map<string, unknown>;

  /** List of registered endpoint paths. */
  readonly endpoints: string[];
  
  /** List of registered middleware functions. */
  readonly middleware: TaskimaticMiddleware[];

  // --- Lifecycle & Registration Methods ---
  
  /** Register an endpoint with a single handler or a map of HTTP verbs. */
  end(path: string, handler: TaskimaticRouteHandler): void;
  
  /** Register global or path-specific middleware. */
  use(middleware: TaskimaticMiddleware): void;
  
  /** Stop the server from listening to a specific endpoint dynamically. */
  silence(endpoint: string): void;
  
  /** Start the server and listen for incoming requests. */
  listen(endpoint: string | number, callback?: () => void): void;
  
  /** Register a lifecycle event hook (e.g., 'startup', 'shutdown'). */
  on(event: 'startup' | 'shutdown' | 'error', callback: (err?: Error) => void | Promise<void>): void;
  
  /** Standardize outbound responses. */
  reply(status: number, payload: unknown, headers?: Record<string, string>): NativeResponse;
}

// ============================================================================
// 5. HANDLERS AND MIDDLEWARE
// ============================================================================

/** The core functional signature for an endpoint handler. */
export type TaskimaticHandler<
  TParams = unknown,
  TQuery = unknown,
  TUser = unknown,
  TSession = unknown,
  TEnv = DefaultEnv
> = (
  request: TaskimaticRequest<TParams, TQuery>,
  requestor: Requestor<TUser, TSession>,
  server: ServerContext<TEnv>
) => NativeResponse | Promise<NativeResponse>;

/** Allows endpoint registration to be verb-agnostic or strictly mapped. */
export type TaskimaticRouteHandler = 
  | TaskimaticHandler 
  | Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS', TaskimaticHandler>>;

/** Middleware signature (intercepts before the handler). */
export type TaskimaticMiddleware = (
  request: TaskimaticRequest,
  requestor: Requestor,
  server: ServerContext,
  next: () => Promise<NativeResponse>
) => Promise<NativeResponse>;

// ============================================================================
// 6. CORE CLASS INSTANTIATION
// ============================================================================

export interface TaskimaticOptions<TEnv, TRouter, TResolver> {
  Environment?: TEnv;
  Router?: TRouter;
  Resolver?: TResolver;
}

/** The main entry point class as described. */
export declare class Taskimatic<TEnv = DefaultEnv, TRouter = unknown, TResolver = unknown> {
  constructor(options?: TaskimaticOptions<TEnv, TRouter, TResolver>);
  
  /** Maps directly to server.end */
  end(path: string, handler: TaskimaticRouteHandler): void;
}