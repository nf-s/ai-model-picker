import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { COOKIE_NAMES } from '../server/auth/index.mjs';
import { restrictedFixture } from '../server/auth/restricted-fixture.mjs';
import { ENV, harness } from '../server/auth/test-support.mjs';
import { handleRestrictedRequest } from '../server/restricted.mjs';

const opened = [];
function setup() {
  const value = harness();
  opened.push(value.binding);
  value.dependencies = { ...value.dependencies, results: restrictedFixture };
  return value;
}
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

const viewer = {
  email: 'friend@gmail.com',
  sub: 'friend-456',
  authoritativeEmail: true,
};

function request(session, method = 'GET') {
  return new Request(`${ENV.PUBLIC_URL}/api/restricted`, {
    method,
    headers: session
      ? { Cookie: `${COOKIE_NAMES.session}=${session.sessionToken}` }
      : {},
  });
}

async function grantedViewer(h) {
  const admin = await h.login();
  await h.auth.grantEmail(
    admin.sessionToken,
    admin.csrfToken,
    ENV.PUBLIC_URL,
    viewer.email,
  );
  return { admin, session: await h.login(viewer) };
}

test('unauthenticated and ungranted requests receive no restricted results', async () => {
  const h = setup();
  const denied = await handleRestrictedRequest(
    request(),
    h.env,
    h.dependencies,
  );
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error, 'authentication_required');
  await assert.rejects(
    () => h.login(viewer),
    (error) => error.status === 403,
  );
});

test('a granted session receives the restricted results with private headers', async () => {
  const h = setup();
  const { session } = await grantedViewer(h);
  const allowed = await handleRestrictedRequest(
    request(session),
    h.env,
    h.dependencies,
  );
  assert.equal(allowed.status, 200);
  for (const [name, value] of [
    ['content-type', 'application/json; charset=utf-8'],
    ['cache-control', 'private, no-store'],
    ['vary', 'Cookie'],
    ['x-robots-tag', 'noindex, nofollow, noarchive'],
    ['x-content-type-options', 'nosniff'],
    ['referrer-policy', 'no-referrer'],
  ])
    assert.equal(allowed.headers.get(name), value, name);
  assert.deepEqual(await allowed.json(), { results: restrictedFixture });
  const head = await handleRestrictedRequest(
    request(session, 'HEAD'),
    h.env,
    h.dependencies,
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('revocation immediately closes the restricted endpoint', async () => {
  const h = setup();
  const { admin, session } = await grantedViewer(h);
  await h.auth.revokeEmail(
    admin.sessionToken,
    admin.csrfToken,
    ENV.PUBLIC_URL,
    viewer.email,
  );
  const revoked = await handleRestrictedRequest(
    request(session),
    h.env,
    h.dependencies,
  );
  assert.equal(revoked.status, 401);
});

test('only GET and HEAD are allowed', async () => {
  const h = setup();
  const { session } = await grantedViewer(h);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const result = await handleRestrictedRequest(
      request(session, method),
      h.env,
      h.dependencies,
    );
    assert.equal(result.status, 405, method);
    assert.equal(result.headers.get('allow'), 'GET, HEAD');
  }
});
