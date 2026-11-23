import { useEffect, useState } from 'react';

// A model page names one exact model or one product line; a line's records
// are never merged into a model.
export type ModelTarget =
  { kind: 'model'; id: string } | { kind: 'line'; name: string };
export type Route =
  | { view: 'brief'; job: string | null }
  | {
      view: 'model';
      // null lists the models.
      target: ModelTarget | null;
      // The job whose bands are shown; null for all jobs.
      job: string | null;
      // The thread reader is open under the Crowd band.
      comments: boolean;
    }
  | { view: 'switch'; a: string | null; b: string | null; job: string | null }
  // The people list, or one person's page; the job filters their records.
  | { view: 'people'; name: string | null; job: string | null }
  // Word search; the job filters the results.
  | { view: 'search'; words: string; job: string | null }
  | { view: 'benchmark'; id: string }
  | { view: 'apps' }
  // `papers` marks the line saying why arXiv papers were removed, where old
  // Papers links land.
  | { view: 'data'; section: 'papers' | null }
  | { view: 'account'; error: string | null };

// Hashes from the redesign period (`#/redesign/model/...`) keep working.
// Those that opened the Board (`#/board`, `#/redesign/board`), like the root
// and unknown hashes, open Brief's job chooser.
const legacyPrefix = 'redesign/';
const linePrefix = 'line/';

// A model page's target from the address. The older key forms
// (`model:<id>`, `family:<name>`) still land on the same page.
function modelTarget(detail: string): ModelTarget | null {
  if (!detail) return null;
  if (detail.startsWith(linePrefix)) {
    const name = decode(detail.slice(linePrefix.length));
    return name ? { kind: 'line', name } : null;
  }
  const value = decode(detail);
  if (value.startsWith('model:'))
    return value.length > 6 ? { kind: 'model', id: value.slice(6) } : null;
  if (value.startsWith('family:'))
    return value.length > 7 ? { kind: 'line', name: value.slice(7) } : null;
  return { kind: 'model', id: value };
}

function modelPath(target: ModelTarget | null) {
  if (target === null) return '#/model';
  return target.kind === 'model'
    ? `#/model/${encodeURIComponent(target.id)}`
    : `#/model/line/${encodeURIComponent(target.name)}`;
}

function jobQuery(job: string | null, comments = false) {
  const query = new URLSearchParams();
  if (job) query.set('job', job);
  if (comments) query.set('comments', 'open');
  const text = query.toString();
  return text ? `?${text}` : '';
}

function decode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Keys are encoded, so the first literal `?` starts the query.
function splitQuery(path: string) {
  const mark = path.indexOf('?');
  return mark < 0
    ? { path, query: new URLSearchParams() }
    : {
        path: path.slice(0, mark),
        query: new URLSearchParams(path.slice(mark + 1)),
      };
}

export function parseRoute(hash: string): Route {
  const trimmed = hash.replace(/^#\/?/, '');
  const legacy = trimmed.startsWith(legacyPrefix);
  const { path, query } = splitQuery(
    legacy ? trimmed.slice(legacyPrefix.length) : trimmed,
  );
  const [view, ...rest] = path.split('/');
  const detail = rest.join('/');
  const value = detail ? decode(detail) : null;
  const job = query.get('job') || null;
  if (view === 'brief') return { view, job: value };
  if (view === 'model') {
    const target = modelTarget(detail);
    const comments = target !== null && query.get('comments') === 'open';
    return { view, target, job, comments };
  }
  // Discussion left the app: its links open the same model or line page with
  // the thread reader open under the Crowd band.
  if (view === 'discussion') {
    const target = modelTarget(detail);
    return { view: 'model', target, job, comments: target !== null };
  }
  if (view === 'switch') {
    const [a, b] = rest.map(decode);
    return { view, a: a || null, b: b || null, job };
  }
  // arXiv papers left the app; old Papers links open the Data page at the
  // line that says why.
  if (view === 'papers') return { view: 'data', section: 'papers' };
  if (view === 'benchmark' && value) return { view, id: value };
  if (view === 'apps') return { view };
  if (view === 'people') return { view, name: value, job };
  if (view === 'search') return { view, words: value ?? '', job };
  // Expert articles moved onto person pages.
  if (view === 'expert-articles') return { view: 'people', name: null, job };
  if (view === 'data')
    return { view, section: value === 'papers' ? value : null };
  if (view === 'account') return { view, error: query.get('error') };
  return { view: 'brief', job: null };
}

export function routeHref(route: Route) {
  if (route.view === 'brief')
    return route.job ? `#/brief/${encodeURIComponent(route.job)}` : '#/';
  if (route.view === 'benchmark')
    return `#/benchmark/${encodeURIComponent(route.id)}`;
  if (route.view === 'apps') return '#/apps';
  if (route.view === 'data')
    return route.section ? `#/data/${route.section}` : '#/data';
  if (route.view === 'people')
    return `#/people${route.name === null ? '' : `/${encodeURIComponent(route.name)}`}${jobQuery(route.job)}`;
  if (route.view === 'search')
    return `#/search${route.words ? `/${encodeURIComponent(route.words)}` : ''}${jobQuery(route.job)}`;
  if (route.view === 'account')
    return `#/account${route.error ? `?${new URLSearchParams({ error: route.error })}` : ''}`;
  if (route.view === 'model')
    return `${modelPath(route.target)}${jobQuery(route.job, route.comments && route.target !== null)}`;
  const a = route.a === null ? '' : `/${encodeURIComponent(route.a)}`;
  const b = route.b === null ? '' : `/${encodeURIComponent(route.b)}`;
  return `#/switch${b ? `${a || '/'}${b}` : a}${jobQuery(route.job)}`;
}

export const modelHref = (id: string, job: string | null = null) =>
  routeHref({
    view: 'model',
    target: { kind: 'model', id },
    job,
    comments: false,
  });
export const lineHref = (name: string, job: string | null = null) =>
  routeHref({
    view: 'model',
    target: { kind: 'line', name },
    job,
    comments: false,
  });

export const personHref = (name: string, job: string | null = null) =>
  routeHref({ view: 'people', name, job });

export function useHash() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return hash;
}
