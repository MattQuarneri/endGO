import { describe, expect, spyOn, test } from 'bun:test';
import {
  createendGORequest,
  createInitialRequestor,
  createReply,
} from '../src/index.js';

describe('createendGORequest lazy resolved metadata', () => {
  test('lazily resolves url, cookies, query, accepts, ip, protocol, fresh, and params', () => {
    const raw = new Request('https://api.example.com/tasks/42?filter=open&sort=asc', {
      method: 'GET',
      headers: {
        cookie: 'session=abc%20123; theme=dark; session=ignored',
        accept: 'text/plain;q=0.5, application/json;q=0.9, */*;q=0.1',
        'cf-connecting-ip': '203.0.113.10',
        'x-forwarded-for': '198.51.100.1, 10.0.0.1',
        'x-forwarded-proto': 'https',
        'if-none-match': '"etag-123"',
      },
    });

    const req = createendGORequest<{ id: string }, { filter: string; sort: string }>(
      raw,
      { id: '42' }
    );

    expect(Object.isFrozen(req)).toBe(true);
    expect(req.raw).toBe(raw);
    expect(req.resolved.url.pathname).toBe('/tasks/42');
    expect(req.resolved.method).toBe('GET');
    expect(req.resolved.params).toEqual({ id: '42' });
    expect(req.resolved.query).toEqual({ filter: 'open', sort: 'asc' });
    expect(req.resolved.cookies).toEqual({ session: 'abc 123', theme: 'dark' });
    expect(req.resolved.accepts).toEqual([
      'application/json',
      'text/plain',
      '*/*',
    ]);
    expect(req.resolved.ip).toBe('203.0.113.10');
    expect(req.resolved.protocol).toBe('https');
    expect(req.resolved.fresh).toBe(true);

    // Subsequent accesses return the exact memoized object references
    expect(req.resolved.cookies).toBe(req.resolved.cookies);
    expect(req.resolved.query).toBe(req.resolved.query);
    expect(req.resolved.params).toBe(req.resolved.params);

    // Immutability check
    expect(() => {
      (req.resolved as Record<string, unknown>).ip = '127.0.0.1';
    }).toThrow(TypeError);
  });

  test('resolves ip fallback chain, protocol from URL, and fresh=false for no-cache or POST', () => {
    const req1 = createendGORequest(
      new Request('http://localhost:3000/items', {
        method: 'GET',
        headers: {
          'x-forwarded-for': '198.51.100.42, 10.0.0.2',
          'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT',
          'cache-control': 'max-age=0, no-cache',
        },
      })
    );
    expect(req1.resolved.ip).toBe('198.51.100.42');
    expect(req1.resolved.protocol).toBe('http');
    expect(req1.resolved.fresh).toBe(false);

    const req2 = createendGORequest(
      new Request('http://localhost:3000/items', {
        method: 'POST',
        headers: {
          'x-real-ip': '192.0.2.55',
          'if-none-match': '"v1"',
        },
      })
    );
    expect(req2.resolved.ip).toBe('192.0.2.55');
    expect(req2.resolved.fresh).toBe(false);
  });
});

describe('createendGORequest lazy pure-callback body parsing', () => {
  test('GET requests and empty-body requests have body === null and files(cb) receives null', async () => {
    const getReq = createendGORequest(new Request('https://example.com/tasks'));
    expect(getReq.resolved.body).toBeNull();
    const filesResult = await getReq.resolved.files((files) => ({
      received: files,
    }));
    expect(filesResult).toEqual({ received: null });

    const emptyPost = createendGORequest(
      new Request('https://example.com/tasks', { method: 'POST' })
    );
    expect(emptyPost.resolved.body).toBeNull();
  });

  test('memoizes stream reads across repeated and cross-accessor calls (literal -> json -> object -> blob)', async () => {
    const raw = new Request('https://example.com/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Ship endGO', priority: 1 }),
    });

    const arrayBufferSpy = spyOn(raw, 'arrayBuffer');
    const req = createendGORequest(raw);
    const body = req.resolved.body!;
    expect(body).not.toBeNull();

    // Stream has not been touched before invoking an accessor
    expect(arrayBufferSpy).toHaveBeenCalledTimes(0);

    const textLen = await body.literal((text) => text?.length ?? 0);
    expect(textLen).toBeGreaterThan(0);
    expect(arrayBufferSpy).toHaveBeenCalledTimes(1);

    // Second literal() call reuses memoized buffer
    const rawText = await body.literal((text) => text);
    expect(rawText).toContain('Ship endGO');
    expect(arrayBufferSpy).toHaveBeenCalledTimes(1);

    // Cross-accessor json() and object() reuse the exact same buffered read
    const title = await body.json<{ title: string }, string>(
      (data) => data?.title ?? ''
    );
    expect(title).toBe('Ship endGO');
    expect(arrayBufferSpy).toHaveBeenCalledTimes(1);

    const priority = await body.object<{ priority: number }, number>(
      (data) => data?.priority ?? 0
    );
    expect(priority).toBe(1);
    expect(arrayBufferSpy).toHaveBeenCalledTimes(1);

    const blobSize = await body.blob((b) => b?.size ?? 0);
    expect(blobSize).toBe(rawText!.length);
    expect(arrayBufferSpy).toHaveBeenCalledTimes(1);
  });

  test('parses urlencoded form and multipart formData + files callbacks', async () => {
    const urlencodedReq = createendGORequest(
      new Request('https://example.com/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'username=alice&role=admin',
      })
    );

    const username = await urlencodedReq.resolved.body!.form((fd) =>
      fd?.get('username')
    );
    expect(username).toBe('alice');

    const multipart = new FormData();
    multipart.append('title', 'Upload spec');
    multipart.append('attachment', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
    multipart.append('gallery', new File(['a'], 'a.png', { type: 'image/png' }));
    multipart.append('gallery', new File(['b'], 'b.png', { type: 'image/png' }));

    const multipartReq = createendGORequest(
      new Request('https://example.com/upload', {
        method: 'POST',
        body: multipart,
      })
    );

    const singleFileName = await multipartReq.resolved.files((files) => {
      const att = files?.attachment;
      return att instanceof File ? att.name : null;
    });
    expect(singleFileName).toBe('hello.txt');

    const galleryCount = await multipartReq.resolved.body!.files((files) => {
      const gallery = files?.gallery;
      return Array.isArray(gallery) ? gallery.length : 0;
    });
    expect(galleryCount).toBe(2);
  });

  test('exposes unbuffered body.stream without reading into arrayBuffer', async () => {
    const raw = new Request('https://example.com/stream', {
      method: 'POST',
      body: 'stream-chunk',
    });
    const arrayBufferSpy = spyOn(raw, 'arrayBuffer');
    const req = createendGORequest(raw);

    const stream = req.resolved.body!.stream;
    expect(stream).not.toBeNull();
    expect(arrayBufferSpy).toHaveBeenCalledTimes(0);

    const reader = stream!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('stream-chunk');
    reader.releaseLock();
  });
});

describe('createInitialRequestor immutability and lazy device Proxy', () => {
  test('returns frozen Requestor and defers User-Agent parsing until device is accessed', () => {
    const raw = new Request('https://example.com', {
      headers: {
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
        'accept-language': 'fr-CA,fr;q=0.9,en;q=0.8',
        'cf-timezone': 'America/Toronto',
      },
    });

    const getHeaderSpy = spyOn(raw.headers, 'get');
    const requestor = createInitialRequestor(raw);

    expect(Object.isFrozen(requestor)).toBe(true);
    expect(requestor.locale).toBe('fr-CA');
    expect(requestor.timezone).toBe('America/Toronto');
    expect(requestor.user).toBeNull();
    expect(requestor.tenant).toBeNull();

    // User-Agent must NOT have been parsed during createInitialRequestor
    expect(getHeaderSpy).not.toHaveBeenCalledWith('user-agent');

    // Spreading requestor preserves the lazy device Proxy without triggering UA parse
    const hydrated = Object.freeze({
      ...requestor,
      user: { id: 'u1' },
      authProvider: 'bearer',
    });
    expect(getHeaderSpy).not.toHaveBeenCalledWith('user-agent');

    // Accessing device.isMobile triggers lazy UA parsing once
    expect(hydrated.device.isMobile).toBe(true);
    expect(hydrated.device.os).toBe('iOS');
    expect(hydrated.device.browser).toBe('Safari');
    expect(getHeaderSpy).toHaveBeenCalledWith('user-agent');
    expect(getHeaderSpy.mock.calls.filter(([h]) => h === 'user-agent').length).toBe(1);

    // Enforces read-only immutability on requestor and device
    expect(() => {
      (hydrated as unknown as Record<string, unknown>).user = null;
    }).toThrow(TypeError);
    expect(() => {
      (hydrated.device as Record<string, unknown>).isMobile = false;
    }).toThrow(TypeError);
  });
});

describe('createReply minimal safe headers and CORS opt-in', () => {
  test('sets X-Content-Type-Options: nosniff without default wildcard CORS', async () => {
    const reply = createReply();
    const res = reply(200, { ok: true });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });

  test('applies opt-in config.cors headers and supports header overrides', async () => {
    const reply = createReply({
      cors: {
        origin: 'https://app.taskimatic.io',
        methods: ['GET', 'POST'],
        headers: ['Authorization', 'Content-Type'],
        credentials: true,
        maxAge: 3600,
      },
    });

    const res = reply(201, 'created', {
      'X-Custom': 'yes',
      'Content-Type': 'text/markdown; charset=utf-8',
    });

    expect(res.status).toBe(201);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://app.taskimatic.io'
    );
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'Authorization, Content-Type'
    );
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('3600');
    expect(res.headers.get('X-Custom')).toBe('yes');
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(await res.text()).toBe('created');
  });

  test('204 and 304 responses strip body even when payload is provided', async () => {
    const reply = createReply();

    const res204 = reply(204, { ignored: true });
    expect(res204.status).toBe(204);
    expect(res204.body).toBeNull();

    const res304 = reply(304, 'ignored');
    expect(res304.status).toBe(304);
    expect(res304.body).toBeNull();
  });
});
