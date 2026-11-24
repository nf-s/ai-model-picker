import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { COOKIE_NAMES } from '../server/auth/index.mjs';
import { restrictedFixture } from '../server/auth/restricted-fixture.mjs';
import { ENV, harness } from '../server/auth/test-support.mjs';
import { namedParts } from '../server/named.mjs';
import { preparedJson } from '../server/restricted.mjs';
import { routeApi } from '../server/routes.mjs';

const opened = [];
const articleFixture = {
  articles: [
    {
      title: 'An example article',
      date: '2026-06-01',
      url: 'https://example.com/article',
    },
  ],
};

// A stand-in for named-private.json with an invented person.
const namedFixture = namedParts({
  version: 1,
  private: 'Served only behind sign-in.',
  review: { model: 'test', methodology: 'test', note: 'Test.' },
  people: [{ name: 'Ada Example', sourceClass: 'first-hand', trusted: true }],
  coverage: [{ job: 'code', use: 1, advice: 1 }],
  pending: [{ old: 'images', use: 1, advice: 0 }],
  tagged: [{ tag: 'drawing-test', use: 1, advice: 0 }],
  use: [{ id: 'ur:000000000000000000000001/1', person: 'Ada Example' }],
  advice: [{ id: 'ma:000000000000000000000001/1', person: 'Ada Example' }],
});

function setup() {
  const value = harness();
  opened.push(value.binding);
  value.dependencies = {
    ...value.dependencies,
    payload: restrictedFixture,
    expertArticles: articleFixture,
    // Serialised once, as the Function does when it starts.
    named: preparedJson(namedFixture.named),
    namedAdvice: preparedJson(namedFixture.advice),
  };
  return value;
}

test('the named file is split into people with use records, and advice', () => {
  assert.deepEqual(Object.keys(namedFixture.named), [
    'version',
    'review',
    'people',
    'coverage',
    'pending',
    'tagged',
    'use',
  ]);
  assert.deepEqual(Object.keys(namedFixture.advice), ['version', 'advice']);
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

const viewer = {
  email: 'friend@gmail.com',
  sub: 'friend-456',
  authoritativeEmail: true,
};

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

for (const [path, fixture] of [
  ['/api/restricted', restrictedFixture],
  ['/api/expert-articles', articleFixture],
  ['/api/named', namedFixture.named],
  ['/api/named/advice', namedFixture.advice],
]) {
  describe(path, () => {
    function request(session, method = 'GET', origin = ENV.PUBLIC_URL) {
      return new Request(`${origin}${path}`, {
        method,
        headers: session
          ? { Cookie: `${COOKIE_NAMES.session}=${session.sessionToken}` }
          : {},
      });
    }

    test('unauthenticated and ungranted requests are denied', async () => {
      const h = setup();
      const denied = await routeApi(request(), h.env, h.dependencies);
      assert.equal(denied.status, 401);
      const body = await denied.text();
      assert.deepEqual(JSON.parse(body), {
        error: 'authentication_required',
        message: 'Authentication is required.',
      });
      // No named data, not even a count, in an error.
      assert.doesNotMatch(body, /Ada Example|ur:|ma:|people|coverage/);
      const head = await routeApi(request(null, 'HEAD'), h.env, h.dependencies);
      assert.equal(head.status, 401);
      await assert.rejects(
        () => h.login(viewer),
        (error) => error.status === 403,
      );
    });

    test('a granted session receives the payload with private headers', async () => {
      const h = setup();
      const { session } = await grantedViewer(h);
      const allowed = await routeApi(request(session), h.env, h.dependencies);
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
      assert.deepEqual(await allowed.json(), fixture);
      const head = await routeApi(
        request(session, 'HEAD'),
        h.env,
        h.dependencies,
      );
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
    });

    test('revocation immediately closes the endpoint', async () => {
      const h = setup();
      const { admin, session } = await grantedViewer(h);
      await h.auth.revokeEmail(
        admin.sessionToken,
        admin.csrfToken,
        ENV.PUBLIC_URL,
        viewer.email,
      );
      const revoked = await routeApi(request(session), h.env, h.dependencies);
      assert.equal(revoked.status, 401);
      assert.doesNotMatch(await revoked.text(), /Ada Example|ur:|ma:/);
    });

    test('alternate origins and missing storage fail closed', async () => {
      const h = setup();
      const { session } = await grantedViewer(h);
      const alias = await routeApi(
        request(session, 'GET', 'https://alias.example.com'),
        h.env,
        h.dependencies,
      );
      assert.equal(alias.status, 400);
      const unavailable = await routeApi(
        request(session),
        { ...h.env, AUTH_DB: undefined },
        { ...h.dependencies, store: undefined },
      );
      assert.equal(unavailable.status, 503);
    });

    test('only GET and HEAD are allowed', async () => {
      const h = setup();
      const { session } = await grantedViewer(h);
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const result = await routeApi(
          request(session, method),
          h.env,
          h.dependencies,
        );
        assert.equal(result.status, 405, method);
        assert.equal(result.headers.get('allow'), 'GET, HEAD');
      }
    });
  });
}
