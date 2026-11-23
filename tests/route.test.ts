import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lineHref,
  modelHref,
  parseRoute,
  routeHref,
} from '../src/lib/route.ts';
import type { Route } from '../src/lib/route.ts';

test('old Papers links open the Data page at the line on removed papers', () => {
  for (const hash of [
    '#/papers',
    '#/papers?area=coding',
    '#/papers/model%3Agpt-6-astra?area=domain',
    '#/papers/family%3AGPT',
    '#/redesign/papers/family%3AGPT?area=vision',
  ])
    assert.deepEqual(
      parseRoute(hash),
      { view: 'data', section: 'papers' },
      hash,
    );
  assert.equal(routeHref({ view: 'data', section: 'papers' }), '#/data/papers');
  assert.deepEqual(parseRoute('#/data'), { view: 'data', section: null });
  assert.deepEqual(parseRoute('#/data/other'), { view: 'data', section: null });
  for (const route of [
    { view: 'data', section: null },
    { view: 'data', section: 'papers' },
  ] satisfies Route[])
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

test('old Board links land on Brief', () => {
  for (const hash of [
    '',
    '#',
    '#/',
    '#/redesign',
    '#/redesign/',
    '#/redesign/board',
    '#/redesign/unknown',
    '#/unknown',
    '#/board',
    '#/board?x=1',
  ])
    assert.deepEqual(parseRoute(hash), { view: 'brief', job: null }, hash);
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

test('every old address lands as the old-links table says', () => {
  const brief: Route = { view: 'brief', job: null };
  const cases: [string, Route][] = [
    // The Board, the redesign prefix and unknown addresses: Brief's chooser.
    ['#/', brief],
    ['#/board', brief],
    ['#/redesign/board', brief],
    ['#/redesign/', brief],
    ['#/no-such-view', brief],
    ['#/boards/x', brief],
    // Model and family keys: the model or line page.
    ['#/model/model:gpt-6-2-sol', model('gpt-6-2-sol')],
    ['#/model/model%3Agpt-6-2-sol', model('gpt-6-2-sol')],
    ['#/redesign/model/model%3Agpt-6-2-sol', model('gpt-6-2-sol')],
    ['#/model/family:Claude', line('Claude')],
    ['#/model/family%3AClaude%20Opus', line('Claude Opus')],
    ['#/redesign/model/family%3AClaude', line('Claude')],
    // Discussion: the same page, Crowd band's thread reader open.
    ['#/discussion/model%3Agpt-6-2-sol', model('gpt-6-2-sol', null, true)],
    ['#/discussion/model:gpt-6-2-sol', model('gpt-6-2-sol', null, true)],
    ['#/discussion/family%3AClaude', line('Claude', null, true)],
    ['#/redesign/discussion/family%3AGPT', line('GPT', null, true)],
    // Papers: the Data page's line on why papers were removed.
    ['#/papers', { view: 'data', section: 'papers' }],
    [
      '#/papers/model%3Agpt-6-astra?area=coding',
      { view: 'data', section: 'papers' },
    ],
    ['#/redesign/papers', { view: 'data', section: 'papers' }],
    // Expert articles: People.
    ['#/expert-articles', { view: 'people', name: null, job: null }],
    ['#/redesign/expert-articles', { view: 'people', name: null, job: null }],
    // Kept routes are unchanged.
    ['#/benchmark/epoch-eci', { view: 'benchmark', id: 'epoch-eci' }],
    ['#/redesign/benchmark/epoch-eci', { view: 'benchmark', id: 'epoch-eci' }],
    ['#/apps', { view: 'apps' }],
    ['#/redesign/apps', { view: 'apps' }],
    ['#/data', { view: 'data', section: null }],
    ['#/redesign/data', { view: 'data', section: null }],
    ['#/account', { view: 'account', error: null }],
  ];
  for (const [hash, route] of cases)
    assert.deepEqual(parseRoute(hash), route, hash);
});
