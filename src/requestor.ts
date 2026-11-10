import type { DeviceInfo, Requestor } from './types.js';

const EMPTY_STRING_ARRAY: readonly string[] = Object.freeze([]);
const MOBILE_UA_PATTERN = /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
const BOT_UA_PATTERN = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit/i;

function parseLocale(headers: Headers): string {
  const acceptLanguage = headers.get('accept-language');
  if (!acceptLanguage) {
    return 'en-US';
  }

  const first = acceptLanguage.split(',')[0]?.split(';')[0]?.trim();
  if (!first || first === '*') {
    return 'en-US';
  }

  return first;
}

function parseTimezone(headers: Headers): string {
  const cfTz = headers.get('cf-timezone')?.trim();
  if (cfTz) {
    return cfTz;
  }

  const xTz = headers.get('x-timezone')?.trim();
  if (xTz) {
    return xTz;
  }

  return 'UTC';
}

function detectBrowser(ua: string): string {
  if (!ua) return 'Unknown';
  if (/Edg\/|Edge\//i.test(ua)) return 'Edge';
  if (/OPR\/|Opera\//i.test(ua)) return 'Opera';
  if (/SamsungBrowser\//i.test(ua)) return 'Samsung Internet';
  if (/Chrome\/|CriOS\//i.test(ua)) return 'Chrome';
  if (/Firefox\/|FxiOS\//i.test(ua)) return 'Firefox';
  if (/Safari\//i.test(ua)) return 'Safari';
  if (/curl\//i.test(ua)) return 'curl';
  if (BOT_UA_PATTERN.test(ua)) return 'Bot';
  return 'Unknown';
}

function detectOs(ua: string): string {
  if (!ua) return 'Unknown';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/CrOS/i.test(ua)) return 'ChromeOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Unknown';
}

function parseUserAgent(ua: string): Readonly<DeviceInfo> {
  return Object.freeze({
    browser: detectBrowser(ua),
    os: detectOs(ua),
    isMobile: MOBILE_UA_PATTERN.test(ua),
    userAgent: ua,
  });
}

function createLazyDeviceProxy(raw: Request): Readonly<DeviceInfo> {
  const target: Record<string, unknown> = {};
  let parsed: Readonly<DeviceInfo> | null = null;

  const ensureParsed = (): Readonly<DeviceInfo> => {
    if (!parsed) {
      parsed = parseUserAgent(raw.headers.get('user-agent') ?? '');
      Object.assign(target, parsed);
      Object.freeze(target);
    }
    return parsed;
  };

  return new Proxy(target as Readonly<DeviceInfo>, {
    get(obj, prop, receiver) {
      ensureParsed();
      return Reflect.get(obj, prop, receiver);
    },
    has(obj, prop) {
      ensureParsed();
      return Reflect.has(obj, prop);
    },
    ownKeys(obj) {
      ensureParsed();
      return Reflect.ownKeys(obj);
    },
    getOwnPropertyDescriptor(obj, prop) {
      ensureParsed();
      return Reflect.getOwnPropertyDescriptor(obj, prop);
    },
    isExtensible(obj) {
      ensureParsed();
      return Reflect.isExtensible(obj);
    },
    preventExtensions(obj) {
      ensureParsed();
      return Reflect.preventExtensions(obj);
    },
    getPrototypeOf(obj) {
      return Reflect.getPrototypeOf(obj);
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
    setPrototypeOf() {
      return false;
    },
  });
}

/**
 * Creates an immutable initial {@link Requestor} snapshot with lazy device metadata resolution.
 */
export function createInitialRequestor(raw: Request): Requestor {
  return Object.freeze({
    user: null,
    tenant: null,
    session: null,
    token: null,
    authProvider: null,
    roles: EMPTY_STRING_ARRAY,
    permissions: EMPTY_STRING_ARRAY,
    locale: parseLocale(raw.headers),
    timezone: parseTimezone(raw.headers),
    device: createLazyDeviceProxy(raw),
  });
}
