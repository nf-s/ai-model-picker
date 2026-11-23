import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRoute, routeHref } from '../src/lib/route.ts';
import type { Route } from '../src/lib/route.ts';

test('the papers route carries an optional area', () => {
  assert.deepEqual(parseRoute('#/papers'), {
    view: 'papers',
    key: null,
    area: null,
  });
  assert.deepEqual(parseRoute('#/papers?area=coding'), {
    view: 'papers',
    key: null,
    area: 'coding',
  });
  assert.deepEqual(parseRoute('#/papers/model%3Agpt-6-astra?area=domain'), {
    view: 'papers',
    key: 'model:gpt-6-astra',
    area: 'domain',
  });
  assert.deepEqual(parseRoute('#/redesign/papers/family%3AGPT?area=vision'), {
    view: 'papers',
    key: 'family:GPT',
    area: 'vision',
  });
});

test('an unknown or empty area is ignored', () => {
  for (const hash of [
    '#/papers/model%3Aa?area=cooking',
    '#/papers/model%3Aa?area=',
    '#/papers/model%3Aa?area=Coding',
    '#/papers/model%3Aa?topic=coding',
  ])
    assert.deepEqual(
      parseRoute(hash),
      { view: 'papers', key: 'model:a', area: null },
      hash,
    );
});

test('routeHref writes the area and parses back', () => {
  const routes: Route[] = [
    { view: 'papers', key: null, area: null },
    { view: 'papers', key: null, area: 'coding' },
    { view: 'papers', key: 'model:gpt-6-astra', area: null },
    { view: 'papers', key: 'family:Claude ?&/', area: 'writing' },
  ];
  assert.deepEqual(
    routes.map((route) => routeHref(route)),
    [
      '#/papers',
      '#/papers?area=coding',
      '#/papers/model%3Agpt-6-astra',
      '#/papers/family%3AClaude%20%3F%26%2F?area=writing',
    ],
  );
  for (const route of routes)
    assert.deepEqual(parseRoute(routeHref(route)), route);
});

test('other views are unchanged', () => {
  assert.deepEqual(parseRoute('#/model/model%3Aa'), {
    view: 'model',
    key: 'model:a',
  });
  assert.deepEqual(parseRoute('#/benchmark/swe'), {
    view: 'benchmark',
    id: 'swe',
  });
  assert.equal(
    routeHref({ view: 'model', key: 'model:a' }),
    '#/model/model%3Aa',
  );
});

test('the account route carries a sign-in error code', () => {
  assert.deepEqual(parseRoute('#/account'), { view: 'account', error: null });
  assert.deepEqual(parseRoute('#/account?error=access_denied'), {
    view: 'account',
    error: 'access_denied',
  });
  assert.equal(
    routeHref({ view: 'account', error: 'invalid_state' }),
    '#/account?error=invalid_state',
  );
});

test('Expert articles has a standalone bookmarkable route', () => {
  const hash = routeHref({ view: 'expert-articles' });
  assert.equal(hash, '#/expert-articles');
  assert.deepEqual(parseRoute(hash), { view: 'expert-articles' });
});

test('Brief is the home page and the job is in the address', () => {
  assert.deepEqual(parseRoute(''), { view: 'brief', job: null });
  assert.deepEqual(parseRoute('#/'), { view: 'brief', job: null });
  assert.deepEqual(parseRoute('#/brief'), { view: 'brief', job: null });
  assert.deepEqual(parseRoute('#/brief/bug-fix'), {
    view: 'brief',
    job: 'bug-fix',
  });
  for (const route of [
    { view: 'brief', job: null },
    { view: 'brief', job: 'coding' },
    { view: 'board' },
  ] satisfies Route[])
    assert.deepEqual(parseRoute(routeHref(route)), route);
  assert.equal(routeHref({ view: 'brief', job: null }), '#/');
  assert.equal(
    routeHref({ view: 'brief', job: 'interface' }),
    '#/brief/interface',
  );
});

test('an unknown job id stays in the route for Brief to report', () => {
  // Brief shows a notice for a job the job list does not have; the route
  // does not swap in another job.
  assert.deepEqual(parseRoute('#/brief/no-such-job'), {
    view: 'brief',
    job: 'no-such-job',
  });
});

test('old Board links land on Brief and the Board keeps its own route', () => {
  for (const hash of [
    '',
    '#',
    '#/',
    '#/redesign',
    '#/redesign/',
    '#/redesign/board',
    '#/redesign/unknown',
    '#/unknown',
  ])
    assert.deepEqual(parseRoute(hash), { view: 'brief', job: null }, hash);
  assert.deepEqual(parseRoute('#/board'), { view: 'board' });
  assert.equal(routeHref({ view: 'board' }), '#/board');
  assert.deepEqual(parseRoute('#/redesign/model/model%3Aa'), {
    view: 'model',
    key: 'model:a',
  });
});
