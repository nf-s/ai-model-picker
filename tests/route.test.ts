import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lineHref,
  modelHref,
  parseRoute,
  routeHref,
} from '../src/lib/route.ts';
import { retiredNotice } from '../src/lib/job-rules.ts';
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

test('the benchmark directory and detail links are bookmarkable', () => {
  const directory: Route = { view: 'benchmarks' };
  assert.equal(routeHref(directory), '#/benchmarks');
  assert.deepEqual(parseRoute(routeHref(directory)), directory);
  assert.deepEqual(parseRoute('#/benchmark/swe'), {
    view: 'benchmark',
    id: 'swe',
  });
  const detail: Route = { view: 'benchmark', id: 'test / benchmark?' };
  assert.deepEqual(parseRoute(routeHref(detail)), detail);
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
    modelHref('gpt-6-2-sol', 'debug'),
    '#/model/gpt-6-2-sol?job=debug',
  );
  assert.deepEqual(parseRoute('#/model'), {
    view: 'model',
    target: null,
    job: null,
    comments: false,
  });
  for (const route of [
    model('gpt-6-2-sol'),
    model('a b/c?d', 'code'),
    model('line'),
    line('Claude'),
    line('GPT ?&/', 'writing', true),
    { view: 'model', target: null, job: 'code', comments: false },
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
  assert.deepEqual(parseRoute('#/switch/a/no-such-model?job=code'), {
    view: 'switch',
    a: 'a',
    b: 'no-such-model',
    job: 'code',
  });
});

test('Switch carries two model ids and the job', () => {
  for (const route of [
    { view: 'switch', a: null, b: null, job: null },
    { view: 'switch', a: 'a', b: null, job: null },
    { view: 'switch', a: null, b: 'b', job: null },
    { view: 'switch', a: 'a', b: 'b', job: 'debug' },
    { view: 'switch', a: 'x/y', b: 'z w', job: null },
  ] satisfies Route[])
    assert.deepEqual(parseRoute(routeHref(route)), route);
  assert.equal(
    routeHref({ view: 'switch', a: 'a', b: 'b', job: 'code' }),
    '#/switch/a/b?job=code',
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
    { view: 'people', name: 'Ada Example', job: 'code' },
    { view: 'people', name: null, job: 'debug' },
  ] satisfies Route[])
    assert.deepEqual(parseRoute(routeHref(route)), route);
  assert.equal(
    routeHref({ view: 'people', name: 'Ada Example', job: 'code' }),
    '#/people/Ada%20Example?job=code',
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
  assert.deepEqual(parseRoute('#/brief/debug'), {
    view: 'brief',
    job: 'debug',
  });
  for (const route of [
    { view: 'brief', job: null },
    { view: 'brief', job: 'code' },
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
    job: 'code',
  };
  const href = routeHref(route);
  assert.equal(href, '#/search/opus%20refactor%20%2F%205.5%3F?job=code');
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

test('a brief can name the surface whose measure orders it', () => {
  const route: Route = { view: 'brief', job: 'code', surface: 'chat-app' };
  assert.equal(routeHref(route), '#/brief/code?surface=chat-app');
  assert.deepEqual(parseRoute('#/brief/code?surface=chat-app'), route);
  // The chooser has no surface.
  assert.deepEqual(parseRoute('#/?surface=chat-app'), {
    view: 'brief',
    job: null,
  });
});

// Every job id of the earlier list in an old address: merged and renamed
// jobs land on their new job; jobs that were split or became a field land on
// the chooser (or the page with all jobs) and name the old job for a notice.
const oldJobs: [string, string | null][] = [
  ['coding', 'code'],
  ['bug-fix', 'debug'],
  ['refactor', 'code'],
  ['tests', 'code'],
  ['review', 'review'],
  ['interface', 'interface'],
  ['agents', null],
  ['delegation', null],
  ['planning', 'plan'],
  ['extraction', 'extraction'],
  ['research', 'research'],
  ['analysis', 'documents'],
  ['writing', 'writing'],
  ['reasoning', null],
  ['chat', 'chat'],
  ['images', null],
  ['local', null],
];

for (const [old, current] of oldJobs)
  test(`an old address with the job ${old} lands as the job list says`, () => {
    const retired = current === null ? { retired: old } : {};
    assert.deepEqual(parseRoute(`#/brief/${old}`), {
      view: 'brief',
      job: current,
      ...retired,
    });
    assert.deepEqual(parseRoute(`#/model/gpt-6-astra?job=${old}`), {
      view: 'model',
      target: { kind: 'model', id: 'gpt-6-astra' },
      job: current,
      comments: false,
      ...retired,
    });
    assert.deepEqual(parseRoute(`#/people?job=${old}`), {
      view: 'people',
      name: null,
      job: current,
      ...retired,
    });
    assert.deepEqual(parseRoute(`#/search/opus?job=${old}`), {
      view: 'search',
      words: 'opus',
      job: current,
      ...retired,
    });
    assert.deepEqual(parseRoute(`#/switch/a/b?job=${old}`), {
      view: 'switch',
      a: 'a',
      b: 'b',
      job: current,
      ...retired,
    });
    if (current === null) assert.match(retiredNotice(old), /no job until/);
  });

test('the notice says what became of a job that is no longer one', () => {
  assert.equal(
    retiredNotice('local'),
    '“Local or private use” is now the Setting filter (local), not a job. Its records have no job until the next review.',
  );
  assert.equal(
    retiredNotice('delegation'),
    '“Parallel agents and delegation” is now the Run filter (parallel), not a job. Its records have no job until the next review.',
  );
  assert.equal(
    retiredNotice('images'),
    '“Images and vision” was split into Read images, scans, audio or video and Make or edit images and video. Its records have no job until the next review.',
  );
  assert.equal(retiredNotice('code'), '');
});
