import { resolveVerb } from './routers/shared.js';
import type {
  DefaultEnv,
  endGOMiddleware,
  ExtractParams,
  HandlerContext,
  IRouter,
  PathResolver,
  RoutePayload,
} from './types.js';

/**
 * Module or payload returned by a lazy endpoint loader.
 */
export type EndpointLoadResult<TPayload> =
  | TPayload
  | { default?: TPayload; actions?: TPayload };

/**
 * Lazy implementation loader for an endpoint or version.
 */
export type EndpointLoader<TPayload> = () => Promise<EndpointLoadResult<TPayload>>;

/**
 * Version entry in {@link EndpointDefinition.versions}: either a direct route payload
 * or an object containing a lazy `load` function.
 */
export type EndpointVersionEntry<
  TPath extends string = string,
  TEnv = DefaultEnv,
  TServices = Record<string, unknown>,
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
  TRouter = IRouter<any>,
  TResolver = PathResolver
> =
  | RoutePayload<
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
  | {
      load: EndpointLoader<
        RoutePayload<
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
      >;
    };

/**
 * Declarative endpoint module definition accepted by {@link defineEndpoint}.
 */
export interface EndpointDefinition<
  TPath extends string = string,
  TEnv = DefaultEnv,
  TServices = Record<string, unknown>,
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
  TRouter = IRouter<any>,
  TResolver = PathResolver
> {
  /** Unique identifier for this endpoint module. */
  id: string;
  /** Route path pattern (e.g. `'/api/items/:id'`). */
  path: TPath;
  /** Optional endpoint-scoped middleware executed before the terminal handler. */
  middleware?: endGOMiddleware<
    TEnv,
    ExtractParams<TPath>,
    Record<string, string>,
    TUser,
    TTenant,
    TSession,
    TServices,
    TRouter,
    TResolver
  >[];
  /** Eager handler or HTTP verb map. */
  actions?: RoutePayload<
    TEnv,
    ExtractParams<TPath>,
    Record<string, string>,
    TUser,
    TTenant,
    TSession,
    TServices,
    TRouter,
    TResolver
  >;
  /** Lazy loader for the endpoint implementation (deduplicates concurrent loads, retries on failure). */
  load?: EndpointLoader<
    RoutePayload<
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
  >;
  /** Versioned implementations for canary cohorts or manual rollback. */
  versions?: Record<
    string,
    EndpointVersionEntry<
      TPath,
      TEnv,
      TServices,
      TUser,
      TTenant,
      TSession,
      TRouter,
      TResolver
    >
  >;
  /** Selects the active version key from {@link versions} for the current request. */
  selectVersion?: (
    context: HandlerContext<
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
  ) => string | Promise<string>;
  /** Fallback handler or verb map invoked on safe reads (`GET`/`HEAD`) when primary fails or times out. */
  fallback?: RoutePayload<
    TEnv,
    ExtractParams<TPath>,
    Record<string, string>,
    TUser,
    TTenant,
    TSession,
    TServices,
    TRouter,
    TResolver
  >;
  /** Optional timeout in milliseconds before triggering fallback on safe reads (`GET`/`HEAD`). */
  timeoutMs?: number;
}

/**
 * Compiled endpoint module ready to be registered via `app.register(endpoint)`.
 */
export interface EndpointModule<
  TPath extends string = string,
  TEnv = DefaultEnv,
  TServices = Record<string, unknown>,
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
  TRouter = IRouter<any>,
  TResolver = PathResolver
> {
  readonly id: string;
  readonly path: TPath;
  readonly middleware: readonly endGOMiddleware<
    TEnv,
    ExtractParams<TPath>,
    Record<string, string>,
    TUser,
    TTenant,
    TSession,
    TServices,
    TRouter,
    TResolver
  >[];
  readonly payload: RoutePayload<
    TEnv,
    ExtractParams<TPath>,
    Record<string, string>,
    TUser,
    TTenant,
    TSession,
    TServices,
    TRouter,
    TResolver
  >;
}

function isLazyVersionEntry<TPayload>(
  entry: unknown
): entry is { load: EndpointLoader<TPayload> } {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'load' in entry &&
    typeof (entry as { load?: unknown }).load === 'function'
  );
}

function unwrapLoadedPayload<TPayload>(loaded: EndpointLoadResult<TPayload>): TPayload {
  if (loaded && typeof loaded === 'object') {
    const record = loaded as { actions?: TPayload; default?: TPayload };
    if (record.actions !== undefined) {
      return record.actions;
    }
    if (record.default !== undefined) {
      return record.default;
    }
  }
  return loaded as TPayload;
}

/**
 * Creates a memoized async loader that deduplicates concurrent first calls
 * and resets on rejection so subsequent requests can retry.
 */
function createLazyLoader<TPayload>(
  loader: EndpointLoader<TPayload>
): () => Promise<TPayload> {
  let cached: TPayload | undefined;
  let hasValue = false;
  let inflight: Promise<TPayload> | null = null;

  return () => {
    if (hasValue) {
      return Promise.resolve(cached as TPayload);
    }
    if (inflight) {
      return inflight;
    }

    inflight = loader()
      .then((raw) => {
        const resolved = unwrapLoadedPayload(raw);
        cached = resolved;
        hasValue = true;
        inflight = null;
        return resolved;
      })
      .catch((err) => {
        inflight = null;
        throw err;
      });

    return inflight;
  };
}

function runWithTimeout<T>(
  work: () => Promise<T>,
  timeoutMs: number | undefined
): Promise<T> {
  if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
    return work();
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Endpoint execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    work().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function dispatchPayload<
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
  payload: RoutePayload<
    TEnv,
    TParams,
    TQuery,
    TUser,
    TTenant,
    TSession,
    TServices,
    TRouter,
    TResolver
  >,
  context: HandlerContext<
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
): Promise<Response> {
  const { handler, allowedMethods } = resolveVerb(
    payload as any,
    context.request.resolved.method
  );

  if (!handler) {
    return context.server.reply(
      405,
      {
        error: 'Method Not Allowed',
        method: context.request.resolved.method,
        allowed: allowedMethods,
      },
      { Allow: allowedMethods.join(', ') }
    );
  }

  return handler(context);
}

/**
 * Defines a composable endpoint module supporting scoped middleware, lazy loading,
 * versioned canary selection, and safe-read (`GET`/`HEAD`) fallbacks.
 */
export function defineEndpoint<
  TPath extends string = string,
  TEnv = DefaultEnv,
  TServices = Record<string, unknown>,
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
  TRouter = IRouter<any>,
  TResolver = PathResolver
>(
  definition: EndpointDefinition<
    TPath,
    TEnv,
    TServices,
    TUser,
    TTenant,
    TSession,
    TRouter,
    TResolver
  >
): EndpointModule<
  TPath,
  TEnv,
  TServices,
  TUser,
  TTenant,
  TSession,
  TRouter,
  TResolver
> {
  type Payload = RoutePayload<
    TEnv,
    ExtractParams<TPath>,
    Record<string, string>,
    TUser,
    TTenant,
    TSession,
    TServices,
    TRouter,
    TResolver
  >;

  const middleware = Object.freeze([...(definition.middleware ?? [])]);

  if (
    definition.actions &&
    !definition.load &&
    !definition.versions &&
    !definition.fallback
  ) {
    return Object.freeze({
      id: definition.id,
      path: definition.path,
      middleware,
      payload: definition.actions,
    });
  }

  const primaryLoader = definition.load
    ? createLazyLoader(definition.load)
    : null;

  const versionLoaders = new Map<string, () => Promise<Payload>>();
  if (definition.versions) {
    for (const [key, entry] of Object.entries(definition.versions)) {
      if (isLazyVersionEntry<Payload>(entry)) {
        versionLoaders.set(key, createLazyLoader(entry.load));
      }
    }
  }

  const resolvePrimaryPayload = async (
    context: HandlerContext<
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
  ): Promise<Payload> => {
    if (definition.versions) {
      const versionKeys = Object.keys(definition.versions);
      const selectedKey = definition.selectVersion
        ? await definition.selectVersion(context)
        : versionKeys[0];

      const versionLoader = versionLoaders.get(selectedKey);
      if (versionLoader) {
        return versionLoader();
      }

      const directVersion = definition.versions[selectedKey];
      if (!directVersion) {
        throw new Error(
          `Unknown version "${selectedKey}" for endpoint "${definition.id}"`
        );
      }
      return directVersion as Payload;
    }

    if (primaryLoader) {
      return primaryLoader();
    }

    if (definition.actions) {
      return definition.actions;
    }

    throw new Error(
      `Endpoint "${definition.id}" has no actions, load, or versions configured`
    );
  };

  const compiledHandler: Payload = async (context) => {
    const method = context.request.resolved.method.toUpperCase();
    const isSafeRead = method === 'GET' || method === 'HEAD';

    const executePrimary = async () => {
      const payload = await resolvePrimaryPayload(context);
      return dispatchPayload(payload, context);
    };

    if (isSafeRead && definition.fallback) {
      try {
        return await runWithTimeout(executePrimary, definition.timeoutMs);
      } catch (err) {
        context.server.logger.warn(
          `Endpoint "${definition.id}" failed on ${method}; serving fallback`,
          err
        );
        return dispatchPayload(definition.fallback, context);
      }
    }

    return executePrimary();
  };

  return Object.freeze({
    id: definition.id,
    path: definition.path,
    middleware,
    payload: compiledHandler,
  });
}
