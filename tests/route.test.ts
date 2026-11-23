import assert from 'node:assert/strict';
import test from 'node:test';
import {
  keyHref,
  lineHref,
  modelHref,
  parseRoute,
  routeHref,
} from '../src/lib/route.ts';
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
  assert.deepEqual(parseRoute('#/benchmark/swe'), {
    view: 'benchmark',
    id: 'swe',
  });
});

const model = (
  id: string,
  job: string | null = null,
  comments = false,
): Route => ({ view: 'model', target: { kind: 'model', id }, job, comments });
const line = (
  name: string,
  job: string | null = null,
  comments = false,
): Route => ({ view: 'model', target: { kind: 'line', name }, job, comments });

test('a model page is addressed by the model id and a line by its name', () => {
  assert.equal(modelHref('gpt-6-2-sol'), '#/model/gpt-6-2-sol');
  assert.equal(lineHref('Claude Opus'), '#/model/line/Claude%20Opus');
  assert.equal(
    modelHref('gpt-6-2-sol', 'bug-fix'),
    '#/model/gpt-6-2-sol?job=bug-fix',
  );
  assert.deepEqual(parseRoute('#/model'), {
    view: 'model',
    target: null,
    job: null,
    comments: false,
  });
  for (const route of [
    model('gpt-6-2-sol'),
    model('a b/c?d', 'coding'),
    model('line'),
    line('Claude'),
    line('GPT ?&/', 'writing', true),
    { view: 'model', target: null, job: 'coding', comments: false },
  ] satisfies Route[])
    assert.deepEqual(parseRoute(routeHref(route)), route);
});

test('old model, family and Discussion links land on the model or line page', () => {
  const cases: [string, Route][] = [
    ['#/model/model%3Agpt-6-2-sol', model('gpt-6-2-sol')],
    ['#/model/model:gpt-6-2-sol', model('gpt-6-2-sol')],
    ['#/redesign/model/model%3Aa', model('a')],
    ['#/model/family%3AClaude', line('Claude')],
    ['#/model/family%3AClaude%20Opus', line('Claude Opus')],
    ['#/redesign/model/family%3AGPT', line('GPT')],
    ['#/discussion/model%3Agpt-6-2-sol', model('gpt-6-2-sol', null, true)],
    ['#/discussion/family%3AClaude', line('Claude', null, true)],
    ['#/redesign/discussion/model%3Aa', model('a', null, true)],
    [
      '#/discussion',
      { view: 'model', target: null, job: null, comments: false },
    ],
    [
      '#/discussion/',
      { view: 'model', target: null, job: null, comments: false },
    ],
  ];
  for (const [hash, route] of cases)
    assert.deepEqual(parseRoute(hash), route, hash);
  assert.equal(keyHref('model:a'), '#/model/a');
  assert.equal(
    keyHref('family:Claude Opus', true),
    '#/model/line/Claude%20Opus?comments=open',
  );
});

test('an unknown model id stays in the route for the page to report', () => {
  assert.deepEqual(parseRoute('#/model/no-such-model'), model('no-such-model'));
  assert.deepEqual(parseRoute('#/switch/a/no-such-model?job=coding'), {
    view: 'switch',
    a: 'a',
    b: 'no-such-model',
    job: 'coding',
  });
});

test('Switch carries two model ids and the job', () => {
  for (const route of [
    { view: 'switch', a: null, b: null, job: null },
    { view: 'switch', a: 'a', b: null, job: null },
    { view: 'switch', a: null, b: 'b', job: null },
    { view: 'switch', a: 'a', b: 'b', job: 'bug-fix' },
    { view: 'switch', a: 'x/y', b: 'z w', job: null },
  ] satisfies Route[])
    assert.deepEqual(parseRoute(routeHref(route)), route);
  assert.equal(
    routeHref({ view: 'switch', a: 'a', b: 'b', job: 'coding' }),
    '#/switch/a/b?job=coding',
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

test('People and person pages are bookmarkable; Expert articles lands on People', () => {
  for (const route of [
    { view: 'people', name: null, job: null },
    { view: 'people', name: 'Ada Example', job: null },
    { view: 'people', name: 'Ada Example', job: 'coding' },
    { view: 'people', name: null, job: 'bug-fix' },
  ] satisfies Route[])
    assert.deepEqual(parseRoute(routeHref(route)), route);
  assert.equal(
    routeHref({ view: 'people', name: 'Ada Example', job: 'coding' }),
    '#/people/Ada%20Example?job=coding',
  );
  assert.deepEqual(parseRoute('#/expert-articles'), {
    view: 'people',
    name: null,
    job: null,
  });
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
  assert.deepEqual(parseRoute('#/redesign/model/model%3Aa'), model('a'));
});

test('the search route carries the words and the job', () => {
  assert.deepEqual(parseRoute('#/search'), {
    view: 'search',
    words: '',
    job: null,
  });
  const route: Route = {
    view: 'search',
    words: 'opus refactor / 5.5?',
    job: 'coding',
  };
  const href = routeHref(route);
  assert.equal(href, '#/search/opus%20refactor%20%2F%205.5%3F?job=coding');
  assert.deepEqual(parseRoute(href), route);
});
