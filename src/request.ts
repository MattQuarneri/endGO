import type { BodyCallback, endGORequest, Resolved, ResolvedBody } from './types.js';

const IDENTITY = <T>(value: T): T => value;

const EMPTY_ARRAY: readonly string[] = Object.freeze([]);

const RESOLVED_KEYS: ReadonlySet<PropertyKey> = new Set([
  'url',
  'cookies',
  'fresh',
  'ip',
  'protocol',
  'headers',
  'method',
  'params',
  'query',
  'accepts',
  'files',
  'body',
]);

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseAcceptHeader(headerValue: string | null): readonly string[] {
  if (!headerValue) {
    return EMPTY_ARRAY;
  }

  const parsed: Array<{ type: string; q: number; index: number }> = [];
  const parts = headerValue.split(',');

  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i].trim();
    if (!segment) continue;

    const subParts = segment.split(';');
    const mediaType = subParts[0].trim();
    if (!mediaType) continue;

    let q = 1;
    for (let j = 1; j < subParts.length; j++) {
      const param = subParts[j].trim();
      if (param.length >= 2 && (param[0] === 'q' || param[0] === 'Q') && param[1] === '=') {
        const numeric = Number.parseFloat(param.slice(2).trim());
        q = Number.isFinite(numeric) ? numeric : 0;
        break;
      }
    }

    parsed.push({ type: mediaType, q, index: i });
  }

  if (parsed.length === 0) {
    return EMPTY_ARRAY;
  }

  parsed.sort((a, b) => (b.q !== a.q ? b.q - a.q : a.index - b.index));
  return Object.freeze(parsed.map((item) => item.type));
}

function parseCookieHeader(headerValue: string | null): Readonly<Record<string, string>> {
  const cookies: Record<string, string> = {};
  if (!headerValue) {
    return Object.freeze(cookies);
  }

  const pairs = headerValue.split(';');
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const eqIndex = pair.indexOf('=');
    if (eqIndex <= 0) continue;

    const rawName = pair.slice(0, eqIndex).trim();
    if (!rawName) continue;

    const rawVal = pair.slice(eqIndex + 1).trim();
    const name = safeDecodeURIComponent(rawName);
    const value = safeDecodeURIComponent(rawVal);

    if (!Object.prototype.hasOwnProperty.call(cookies, name)) {
      cookies[name] = value;
    }
  }

  return Object.freeze(cookies);
}

function resolveClientIp(headers: Headers): string {
  const cfIp = headers.get('cf-connecting-ip');
  if (cfIp) {
    const trimmed = cfIp.trim();
    if (trimmed) return trimmed;
  }

  const forwardedFor = headers.get('x-forwarded-for');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }

  const realIp = headers.get('x-real-ip');
  if (realIp) {
    const trimmed = realIp.trim();
    if (trimmed) return trimmed;
  }

  return '';
}

function resolveProtocol(headers: Headers, url: URL): string {
  const forwardedProto = headers.get('x-forwarded-proto');
  if (forwardedProto) {
    const first = forwardedProto.split(',')[0]?.trim().toLowerCase();
    if (first) return first;
  }
  return url.protocol.replace(/:$/, '');
}

function hasNoCacheDirective(cacheControl: string | null): boolean {
  if (!cacheControl) return false;
  const directives = cacheControl.split(',');
  for (let i = 0; i < directives.length; i++) {
    if (directives[i].trim().toLowerCase() === 'no-cache') {
      return true;
    }
  }
  return false;
}

function applyCallback<T, R>(promise: Promise<T>, fn?: BodyCallback<T, R>): Promise<R> {
  if (!fn) {
    return promise as unknown as Promise<R>;
  }
  return promise.then(fn);
}

function createResolvedBody(raw: Request): ResolvedBody {
  let bufferPromise: Promise<ArrayBuffer> | null = null;
  let blobPromise: Promise<Blob | null> | null = null;
  let literalPromise: Promise<string | null> | null = null;
  let jsonPromise: Promise<unknown> | null = null;
  let formPromise: Promise<FormData | null> | null = null;
  let filesPromise: Promise<Record<string, File | File[]> | null> | null = null;

  let capturedContentType: string | null = null;

  const getBuffer = (): Promise<ArrayBuffer> => {
    if (!bufferPromise) {
      capturedContentType = raw.headers.get('content-type');
      bufferPromise = raw.arrayBuffer();
    }
    return bufferPromise;
  };

  const getBlob = (): Promise<Blob | null> => {
    if (!blobPromise) {
      blobPromise = getBuffer().then((buf) => {
        const type = capturedContentType ?? '';
        return new Blob([buf], type ? { type } : undefined);
      });
    }
    return blobPromise;
  };

  const getLiteral = (): Promise<string | null> => {
    if (!literalPromise) {
      literalPromise = getBuffer().then((buf) => new TextDecoder().decode(buf));
    }
    return literalPromise;
  };

  const getJson = (): Promise<unknown> => {
    if (!jsonPromise) {
      jsonPromise = getLiteral().then((text) => {
        if (text === null || text === '') {
          return null;
        }
        return JSON.parse(text) as unknown;
      });
    }
    return jsonPromise;
  };

  const getForm = (): Promise<FormData | null> => {
    if (!formPromise) {
      formPromise = getBuffer().then(async (buf) => {
        const rawContentType = capturedContentType;
        const contentType = (rawContentType ?? '').toLowerCase();
        if (contentType.includes('application/x-www-form-urlencoded')) {
          const formData = new FormData();
          const searchParams = new URLSearchParams(new TextDecoder().decode(buf));
          for (const [key, value] of searchParams.entries()) {
            formData.append(key, value);
          }
          return formData;
        }
        if (contentType.includes('multipart/form-data')) {
          const headers = rawContentType ? { 'content-type': rawContentType } : raw.headers;
          return await new Response(buf, { headers }).formData();
        }
        return null;
      });
    }
    return formPromise;
  };

  const getFiles = (): Promise<Record<string, File | File[]> | null> => {
    if (!filesPromise) {
      filesPromise = getForm().then((formData) => {
        if (!formData) return null;

        const extracted: Record<string, File | File[]> = {};
        let found = false;

        for (const [key, entry] of formData.entries()) {
          if (entry instanceof File) {
            found = true;
            const existing = extracted[key];
            if (existing === undefined) {
              extracted[key] = entry;
            } else if (Array.isArray(existing)) {
              existing.push(entry);
            } else {
              extracted[key] = [existing, entry];
            }
          }
        }

        return found ? extracted : null;
      });
    }
    return filesPromise;
  };

  const target: ResolvedBody = {
    literal: <R = string | null>(fn?: BodyCallback<string | null, R>) =>
      applyCallback(getLiteral(), fn),
    json: <T = unknown, R = T | null>(fn?: BodyCallback<T | null, R>) =>
      applyCallback(getJson() as Promise<T | null>, fn),
    object: <T = unknown, R = T | null>(fn?: BodyCallback<T | null, R>) =>
      applyCallback(getJson() as Promise<T | null>, fn),
    form: <R = FormData | null>(fn?: BodyCallback<FormData | null, R>) =>
      applyCallback(getForm(), fn),
    files: <R = Record<string, File | File[]> | null>(
      fn?: BodyCallback<Record<string, File | File[]> | null, R>
    ) => applyCallback(getFiles(), fn),
    blob: <R = Blob | null>(fn?: BodyCallback<Blob | null, R>) =>
      applyCallback(getBlob(), fn),
    get stream() {
      return raw.body;
    },
  };

  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'stream') {
        return raw.body;
      }
      return Reflect.get(obj, prop, receiver);
    },
    set() {
      return false;
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
  });
}

/**
 * Creates a lazily resolved, immutable {@link endGORequest} wrapper around a native Web Request.
 */
export function createendGORequest<
  TParams = Record<string, string>,
  TQuery = Record<string, string>
>(
  raw: Request,
  params?: TParams,
  preParsedUrl?: URL
): endGORequest<TParams, TQuery> {
  const cache: Record<string, unknown> = Object.create(null);

  const computeProperty = (prop: string): unknown => {
    if (prop in cache) {
      return cache[prop];
    }

    let value: unknown;
    switch (prop) {
      case 'url':
        value = preParsedUrl ?? new URL(raw.url);
        break;
      case 'method':
        value = raw.method.toUpperCase();
        break;
      case 'headers':
        value = raw.headers;
        break;
      case 'protocol':
        value = resolveProtocol(raw.headers, computeProperty('url') as URL);
        break;
      case 'ip':
        value = resolveClientIp(raw.headers);
        break;
      case 'accepts':
        value = parseAcceptHeader(raw.headers.get('accept'));
        break;
      case 'cookies':
        value = parseCookieHeader(raw.headers.get('cookie'));
        break;
      case 'query': {
        const url = computeProperty('url') as URL;
        value = Object.freeze(Object.fromEntries(url.searchParams.entries())) as Readonly<TQuery>;
        break;
      }
      case 'fresh': {
        const method = computeProperty('method') as string;
        if (method !== 'GET' && method !== 'HEAD') {
          value = false;
        } else if (hasNoCacheDirective(raw.headers.get('cache-control'))) {
          value = false;
        } else {
          value = Boolean(
            raw.headers.get('if-none-match') || raw.headers.get('if-modified-since')
          );
        }
        break;
      }
      case 'params':
        value = Object.freeze({ ...(params ?? {}) }) as Readonly<TParams>;
        break;
      case 'body': {
        const method = computeProperty('method') as string;
        if (raw.body === null || ((method === 'GET' || method === 'HEAD') && raw.body === null)) {
          value = null;
        } else {
          value = createResolvedBody(raw);
        }
        break;
      }
      case 'files':
        value = <R = Record<string, File | File[]> | null>(
          fn?: BodyCallback<Record<string, File | File[]> | null, R>
        ): Promise<R> => {
          const body = computeProperty('body') as ResolvedBody | null;
          if (!body) {
            const callback = (fn ?? IDENTITY) as BodyCallback<
              Record<string, File | File[]> | null,
              R
            >;
            return Promise.resolve(callback(null));
          }
          return body.files(fn);
        };
        break;
      default:
        return undefined;
    }

    cache[prop] = value;
    return value;
  };

  const proxyTarget = Object.create(null) as Resolved<TParams, TQuery>;

  const resolved = new Proxy<Resolved<TParams, TQuery>>(proxyTarget, {
    get(_target, prop) {
      if (typeof prop === 'string' && RESOLVED_KEYS.has(prop)) {
        return computeProperty(prop);
      }
      return undefined;
    },
    has(_target, prop) {
      return RESOLVED_KEYS.has(prop);
    },
    ownKeys() {
      return Array.from(RESOLVED_KEYS) as Array<string | symbol>;
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === 'string' && RESOLVED_KEYS.has(prop)) {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: computeProperty(prop),
        };
      }
      return undefined;
    },
    set() {
      return false;
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
  });

  return Object.freeze({
    raw,
    resolved,
  });
}
