import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { getMigrations } from 'better-auth/db/migration';
import { createDemoApp, createDemoAuth } from './index.ts';

test('Better Auth routes and session middleware work together', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    const auth = createDemoAuth(
      database,
      'integration-test-secret-at-least-32-characters-long'
    );
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    const app = createDemoApp(auth);

    const health = await app.fetch(new Request('http://localhost:3000/health'));
    assert.equal(health.status, 200);

    const anonymous = await app.fetch(new Request('http://localhost:3000/api/me'));
    assert.equal(anonymous.status, 401);

    const signUp = await app.fetch(
      new Request('http://localhost:3000/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Demo User',
          email: 'demo@example.com',
          password: 'password123',
        }),
      })
    );
    assert.equal(signUp.status, 200, await signUp.text());
    const cookies = signUp.headers.getSetCookie().map((header) => header.split(';')[0]);
    assert.ok(cookies.some((cookie) => cookie.includes('session_token=')));

    const authenticated = await app.fetch(
      new Request('http://localhost:3000/api/me', {
        headers: { cookie: cookies.join('; ') },
      })
    );
    assert.equal(authenticated.status, 200);
    const body = (await authenticated.json()) as { user: { email: string } };
    assert.equal(body.user.email, 'demo@example.com');

    const invalid = await app.fetch(
      new Request('http://localhost:3000/api/me', {
        headers: { cookie: 'better-auth.session_token=invalid' },
      })
    );
    assert.equal(invalid.status, 401);
  } finally {
    database.close();
  }
});
