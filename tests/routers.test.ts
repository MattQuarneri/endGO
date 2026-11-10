import { describe, expect, test } from 'bun:test';
import {
  RegExRouter,
  TrieRouter,
  normalizePath,
  resolveVerb,
  splitSegments,
  type IRouter,
} from '../src/index.js';

type DummyHandler = () => Response;

const makeHandler = (name: string): DummyHandler => {
  const fn = () => new Response(name);
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
};

describe('Router shared helpers', () => {
  test('normalizePath ensures leading slash and strips trailing slashes', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('///')).toBe('/');
    expect(normalizePath('tasks')).toBe('/tasks');
    expect(normalizePath('/tasks/')).toBe('/tasks');
    expect(normalizePath('/tasks/123///')).toBe('/tasks/123');
  });

  test('splitSegments splits normalized paths cleanly', () => {
    expect(splitSegments('/')).toEqual([]);
    expect(splitSegments('/tasks')).toEqual(['tasks']);
    expect(splitSegments('/api/tasks/42')).toEqual(['api', 'tasks', '42']);
  });

  test('resolveVerb handles functions, verb maps, ANY, HEAD fallback, and undefined exclusions', () => {
    const getH = makeHandler('get');
    const postH = makeHandler('post');
    const anyH = makeHandler('any');

    const catchAll = resolveVerb(getH, 'DELETE');
    expect(catchAll.handler).toBe(getH);
    expect(catchAll.allowedMethods).toContain('GET');
    expect(catchAll.allowedMethods).toContain('DELETE');

    const headFallback = resolveVerb({ GET: getH, POST: postH }, 'HEAD');
    expect(headFallback.handler).toBe(getH);
    expect(headFallback.allowedMethods).toEqual(['GET', 'POST', 'HEAD']);

    const headExcluded = resolveVerb({ GET: getH, HEAD: undefined }, 'HEAD');
    expect(headExcluded.handler).toBeNull();
    expect(headExcluded.allowedMethods).toEqual(['GET']);

    const anyWithExclusion = resolveVerb({ ANY: anyH, DELETE: undefined }, 'DELETE');
    expect(anyWithExclusion.handler).toBe(anyH);
    expect(anyWithExclusion.allowedMethods).not.toContain('DELETE');
  });
});

function runSharedRouterSuite(name: string, createRouter: () => IRouter<DummyHandler>) {
  describe(name, () => {
    test('matches static, :param, and * wildcard routes', () => {
      const router = createRouter();
      const rootH = makeHandler('root');
      const healthH = makeHandler('health');
      const taskH = makeHandler('task');
      const filesH = makeHandler('files');

      router.listen('/', rootH);
      router.listen('/health', healthH);
      router.listen('/tasks/:id', taskH);
      router.listen('/assets/*', filesH);

      expect(router.match('/', 'GET')).toMatchObject({ handler: rootH, params: {} });
      expect(router.match('/health/', 'GET')).toMatchObject({ handler: healthH, params: {} });
      expect(router.match('/tasks/abc-123', 'GET')).toMatchObject({
        handler: taskH,
        params: { id: 'abc-123' },
      });
      expect(router.match('/assets/css/app.min.css', 'GET')).toMatchObject({
        handler: filesH,
        params: { '*': 'css/app.min.css' },
      });
      expect(router.match('/nonexistent', 'GET')).toBeNull();
    });

    test('matches root wildcard /* for root and nested paths', () => {
      const router = createRouter();
      const catchAllH = makeHandler('catchAll');
      router.listen('/*', catchAllH);

      expect(router.match('/', 'GET')).toMatchObject({
        handler: catchAllH,
        params: { '*': '' },
      });
      expect(router.match('/deep/nested/path', 'GET')).toMatchObject({
        handler: catchAllH,
        params: { '*': 'deep/nested/path' },
      });
    });

    test('prioritizes static > :param > * when registered in specificity order', () => {
      const router = createRouter();
      const staticH = makeHandler('static');
      const paramH = makeHandler('param');
      const wildH = makeHandler('wild');

      router.listen('/tasks/me', staticH);
      router.listen('/tasks/:id', paramH);
      router.listen('/tasks/*', wildH);

      expect(router.match('/tasks/me', 'GET')?.handler).toBe(staticH);
      expect(router.match('/tasks/42', 'GET')).toMatchObject({
        handler: paramH,
        params: { id: '42' },
      });
      expect(router.match('/tasks/42/sub', 'GET')).toMatchObject({
        handler: wildH,
        params: { '*': '42/sub' },
      });
    });

    test('isolates param names across sibling and nested routes', () => {
      const router = createRouter();
      const userH = makeHandler('user');
      const postsH = makeHandler('posts');
      const postDetailH = makeHandler('postDetail');

      router.listen('/users/:id', userH);
      router.listen('/users/:userId/posts', postsH);
      router.listen('/users/:accountId/posts/:postId', postDetailH);

      expect(router.match('/users/u-1', 'GET')).toMatchObject({
        handler: userH,
        params: { id: 'u-1' },
      });
      expect(router.match('/users/u-2/posts', 'GET')).toMatchObject({
        handler: postsH,
        params: { userId: 'u-2' },
      });
      expect(router.match('/users/u-3/posts/p-9', 'GET')).toMatchObject({
        handler: postDetailH,
        params: { accountId: 'u-3', postId: 'p-9' },
      });
    });

    test('supports verb maps, ANY, HEAD fallback to GET, and explicit HEAD: undefined', () => {
      const router = createRouter();
      const getH = makeHandler('get');
      const postH = makeHandler('post');
      const anyH = makeHandler('any');
      const noHeadGetH = makeHandler('noHeadGet');

      router.listen('/items', { GET: getH, POST: postH });
      router.listen('/webhook', { ANY: anyH });
      router.listen('/no-head', { GET: noHeadGetH, HEAD: undefined });

      expect(router.match('/items', 'get')?.handler).toBe(getH);
      expect(router.match('/items', 'POST')?.handler).toBe(postH);
      expect(router.match('/items', 'HEAD')?.handler).toBe(getH);

      expect(router.match('/webhook', 'PUT')?.handler).toBe(anyH);
      expect(router.match('/webhook', 'DELETE')?.handler).toBe(anyH);

      const noHead = router.match('/no-head', 'HEAD');
      expect(noHead).not.toBeNull();
      expect(noHead?.handler).toBeNull();
      expect(noHead?.allowedMethods).toEqual(['GET']);
    });

    test('returns { handler: null, params, allowedMethods } for 405 when path matches but verb is missing', () => {
      const router = createRouter();
      const getH = makeHandler('get');
      const patchH = makeHandler('patch');

      router.listen('/tasks/:id', { GET: getH, PATCH: patchH });

      const match = router.match('/tasks/99', 'DELETE');
      expect(match).not.toBeNull();
      expect(match?.handler).toBeNull();
      expect(match?.params).toEqual({ id: '99' });
      expect(match?.allowedMethods).toEqual(['GET', 'PATCH', 'HEAD']);
    });

    test('silence(path) removes route, updates routes(), and returns accurate boolean', () => {
      const router = createRouter();
      const listH = makeHandler('list');
      const detailH = makeHandler('detail');

      router.listen('/tasks', listH);
      router.listen('/tasks/:id', detailH);

      expect(router.routes().sort()).toEqual(['/tasks', '/tasks/:id']);
      expect(router.silence('/tasks/:id')).toBe(true);
      expect(router.silence('/tasks/:id')).toBe(false);
      expect(router.silence('/unknown')).toBe(false);

      expect(router.routes()).toEqual(['/tasks']);
      expect(router.match('/tasks/123', 'GET')).toBeNull();
      expect(router.match('/tasks', 'GET')?.handler).toBe(listH);
    });
  });
}

runSharedRouterSuite('TrieRouter', () => new TrieRouter<DummyHandler>());
runSharedRouterSuite('RegExRouter', () => new RegExRouter<DummyHandler>());

describe('TrieRouter structural priority and backtracking', () => {
  test('enforces static > :param > * regardless of registration order', () => {
    const router = new TrieRouter<DummyHandler>();
    const wildH = makeHandler('wild');
    const paramH = makeHandler('param');
    const staticH = makeHandler('static');

    // Register least-specific first
    router.listen('/tasks/*', wildH);
    router.listen('/tasks/:id', paramH);
    router.listen('/tasks/me', staticH);

    expect(router.match('/tasks/me', 'GET')?.handler).toBe(staticH);
    expect(router.match('/tasks/101', 'GET')).toMatchObject({
      handler: paramH,
      params: { id: '101' },
    });
    expect(router.match('/tasks/101/comments', 'GET')).toMatchObject({
      handler: wildH,
      params: { '*': '101/comments' },
    });
  });

  test('backtracks cleanly when a deeper static or param branch does not terminate', () => {
    const router = new TrieRouter<DummyHandler>();
    const nestedStaticH = makeHandler('nestedStatic');
    const paramFallbackH = makeHandler('paramFallback');

    router.listen('/orgs/acme/billing', nestedStaticH);
    router.listen('/orgs/:orgId/settings', paramFallbackH);

    // Enters static 'acme' branch, fails on 'settings', backtracks to :orgId
    expect(router.match('/orgs/acme/settings', 'GET')).toMatchObject({
      handler: paramFallbackH,
      params: { orgId: 'acme' },
    });
  });
});
