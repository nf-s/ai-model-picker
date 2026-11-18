import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { onRequest as authFunction } from '../functions/auth/[[path]].js';
import { restrictedFixture } from '../server/auth/restricted-fixture.mjs';
import { COOKIE_NAMES } from '../server/auth/index.mjs';
import { JWKS_ENDPOINT, TOKEN_ENDPOINT } from '../server/auth/google.mjs';
import { base64url } from '../server/auth/security.mjs';
import { ENV, NOW, harness } from '../server/auth/test-support.mjs';
import { routeApi } from '../server/routes.mjs';

// The API Function reads the ignored restricted file; tests use a fixture.
const apiFunction = ({ request, env }) =>
  routeApi(request, env, { results: restrictedFixture });

const opened = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

// Pages Functions use the real clock, so the harness clock follows it.
function setup() {
  const h = harness();
  opened.push(h.binding);
  h.advance(Math.floor(Date.now() / 1000) - NOW);
  return h;
}

function request(path, { method = 'GET', cookie, headers = {} } = {}) {
  return new Request(`${ENV.PUBLIC_URL}${path}`, {
    method,
    headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
  });
}

function assertPrivateHeaders(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(
    response.headers.get('x-robots-tag'),
    'noindex, nofollow, noarchive',
  );
}

test('Pages Functions route auth and API paths and return JSON 404 otherwise', async () => {
  const h = setup();
  for (const [handler, path] of [
    [authFunction, '/auth/unknown'],
    [apiFunction, '/api/unknown'],
    [apiFunction, '/api/restricted/extra'],
  ]) {
    const result = await handler({ request: request(path), env: h.env });
    assert.equal(result.status, 404, path);
    assertPrivateHeaders(result);
    assert.deepEqual(await result.json(), {
      error: 'not_found',
      message: 'Not found.',
    });
  }
  const session = await apiFunction({
    request: request('/api/session'),
    env: h.env,
  });
  assert.deepEqual(await session.json(), { authenticated: false });
  const restricted = await apiFunction({
    request: request('/api/restricted'),
    env: h.env,
  });
  assert.equal(restricted.status, 401);
  const admin = await h.login();
  const allowed = await apiFunction({
    request: request('/api/restricted', {
      cookie: `${COOKIE_NAMES.session}=${admin.sessionToken}`,
    }),
    env: h.env,
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { results: restrictedFixture });
  const unconfigured = { ...h.env };
  delete unconfigured.GOOGLE_CLIENT_SECRET;
  const failed = await apiFunction({
    request: request('/api/restricted'),
    env: unconfigured,
  });
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error, 'configuration_error');
});

test('auth Function preserves all OAuth cookies through a signed callback and safe failure redirect', async () => {
  const h = setup();
  const started = await authFunction({
    request: request('/auth/google/start?next=%2F%23%2Faccount'),
    env: h.env,
  });
  assert.equal(started.status, 303);
  const params = new URL(started.headers.get('location')).searchParams;
  const bindingCookie = started.headers.getSetCookie()[0].split(';')[0];
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const jwk = {
    ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    kid: 'router-key',
    alg: 'RS256',
    use: 'sig',
  };
  const encode = (value) =>
    base64url(new TextEncoder().encode(JSON.stringify(value)));
  const body = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({ iss: 'https://accounts.google.com', aud: ENV.GOOGLE_CLIENT_ID, sub: 'admin-123', email: ENV.ADMIN_EMAIL, email_verified: true, hd: 'example.com', nonce: params.get('nonce'), iat: h.clock(), exp: h.clock() + 3600 })}`;
  const idToken = `${body}.${base64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(body))))}`;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === JWKS_ENDPOINT) return Response.json({ keys: [jwk] });
    assert.equal(url, TOKEN_ENDPOINT);
    return Response.json({
      token_type: 'Bearer',
      access_token: 'discarded-access-token',
      id_token: idToken,
    });
  };
  try {
    const callback = `/auth/google/callback?code=secret-code&state=${params.get('state')}`;
    const completed = await authFunction({
      request: request(callback, { cookie: bindingCookie }),
      env: h.env,
    });
    assert.equal(completed.status, 303);
    assert.equal(completed.headers.get('location'), '/#/account');
    assertPrivateHeaders(completed);
    const cookies = completed.headers.getSetCookie();
    assert.equal(cookies.length, 4);
    for (const value of cookies)
      assert.match(value, /Path=\/; Max-Age=\d+; Secure; SameSite=Lax/);
    assert.ok(
      cookies
        .find((value) => value.startsWith(`${COOKIE_NAMES.session}=`))
        .includes('HttpOnly'),
    );
    assert.ok(
      !cookies
        .find((value) => value.startsWith(`${COOKIE_NAMES.csrf}=`))
        .includes('HttpOnly'),
    );
    const repeated = await authFunction({
      request: request(callback, { cookie: bindingCookie }),
      env: h.env,
    });
    assert.equal(repeated.status, 303);
    assert.equal(
      repeated.headers.get('location'),
      '/#/account?error=invalid_state',
    );
    assert.equal(repeated.headers.getSetCookie().length, 2);
    assert.equal(await repeated.text(), '');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
