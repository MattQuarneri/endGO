import type { endGOMiddleware, MiddlewareContext, Requestor } from '../types.js';

/**
 * Identity snapshot returned by {@link BearerAuthOptions.verify}.
 */
export interface AuthIdentity<
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
> {
  user: TUser | null;
  tenant?: TTenant | null;
  session?: TSession | null;
  token?: string | null;
  roles?: readonly string[];
  permissions?: readonly string[];
  authProvider?: string | null;
}

/**
 * Configuration options for {@link bearerAuth}.
 */
export interface BearerAuthOptions<
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
> {
  verify: (
    token: string,
    context: MiddlewareContext
  ) =>
    | AuthIdentity<TUser, TTenant, TSession>
    | null
    | Promise<AuthIdentity<TUser, TTenant, TSession> | null>;
  realm?: string;
  headerName?: string;
  onUnauthorized?: (
    context: MiddlewareContext
  ) => Response | Promise<Response>;
}

const BEARER_PREFIX = /^Bearer\s+(.+)$/i;

function buildUnauthorizedResponse(
  context: MiddlewareContext,
  options: Pick<BearerAuthOptions, 'realm' | 'onUnauthorized'>
): Response | Promise<Response> {
  if (options.onUnauthorized) {
    return options.onUnauthorized(context);
  }

  const challenge = options.realm
    ? `Bearer realm="${options.realm}"`
    : 'Bearer';

  return context.server.reply(
    401,
    { error: 'Unauthorized' },
    { 'WWW-Authenticate': challenge }
  );
}

/**
 * Extracts and verifies a Bearer token, replacing `context.requestor` with a new
 * frozen {@link Requestor} snapshot on success and returning `401` on missing/invalid tokens.
 */
export function bearerAuth<
  TUser = unknown,
  TTenant = unknown,
  TSession = unknown,
>(
  options: BearerAuthOptions<TUser, TTenant, TSession>
): endGOMiddleware {
  const headerName = options.headerName ?? 'Authorization';

  return async (context, next) => {
    const rawHeader = context.request.resolved.headers.get(headerName);
    const match = rawHeader ? BEARER_PREFIX.exec(rawHeader.trim()) : null;
    const token = match?.[1]?.trim();

    if (!token) {
      return buildUnauthorizedResponse(context, options);
    }

    const identity = await options.verify(token, context);
    if (!identity) {
      return buildUnauthorizedResponse(context, options);
    }

    const prev = context.requestor;
    const nextRequestor: Requestor<TUser, TTenant, TSession> = Object.freeze({
      user: identity.user,
      tenant: identity.tenant ?? null,
      session: identity.session ?? null,
      token: identity.token !== undefined ? identity.token : token,
      roles: Object.freeze([...(identity.roles ?? [])]),
      permissions: Object.freeze([...(identity.permissions ?? [])]),
      device: prev.device,
      locale: prev.locale,
      timezone: prev.timezone,
      authProvider:
        identity.authProvider !== undefined ? identity.authProvider : 'bearer',
    });

    context.requestor = nextRequestor;
    return next();
  };
}

/**
 * Options for {@link requireAuth}.
 */
export interface RequireAuthOptions {
  onUnauthorized?: (
    context: MiddlewareContext
  ) => Response | Promise<Response>;
}

/**
 * Rejects unauthenticated requests (`requestor.user === null`) with `401 Unauthorized`.
 */
export function requireAuth(
  options: RequireAuthOptions = {}
): endGOMiddleware {
  return async (context, next) => {
    if (context.requestor.user === null || context.requestor.user === undefined) {
      if (options.onUnauthorized) {
        return options.onUnauthorized(context);
      }
      return context.server.reply(401, { error: 'Unauthorized' });
    }
    return next();
  };
}

/**
 * Requires the requestor to hold at least one of the specified roles,
 * returning `403 Forbidden` otherwise.
 */
export function requireRole(
  ...roles: string[]
): endGOMiddleware {
  return async (context, next) => {
    if (
      roles.length > 0 &&
      !roles.some((role) => context.requestor.roles.includes(role))
    ) {
      return context.server.reply(403, {
        error: 'Forbidden',
        requiredRoles: roles,
      });
    }
    return next();
  };
}

/**
 * Requires the requestor to hold all specified permissions,
 * returning `403 Forbidden` otherwise.
 */
export function requirePermission(
  ...permissions: string[]
): endGOMiddleware {
  return async (context, next) => {
    if (
      permissions.length > 0 &&
      !permissions.every((perm) => context.requestor.permissions.includes(perm))
    ) {
      return context.server.reply(403, {
        error: 'Forbidden',
        requiredPermissions: permissions,
      });
    }
    return next();
  };
}
