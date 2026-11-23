import { useEffect, useState } from 'react';
import { arxivAreaSchema } from './arxiv-schema.ts';
import type { ArxivArea } from './arxiv-schema.ts';

// A model page names one exact model or one product line; a line's records
// are never merged into a model.
export type ModelTarget =
  { kind: 'model'; id: string } | { kind: 'line'; name: string };
export type Route =
  | { view: 'brief'; job: string | null }
  | { view: 'board' }
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
  | { view: 'papers'; key: string | null; area: ArxivArea | null }
  | { view: 'expert-articles' }
  | { view: 'benchmark'; id: string }
  | { view: 'apps' }
  | { view: 'data' }
  | { view: 'account'; error: string | null };

// Hashes from the redesign period (`#/redesign/model/...`) keep working.
// Those that opened the Board, like the root and unknown hashes, open Brief's
// job chooser; the Board stays at `#/board` until it is removed.
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
  if (view === 'board' && !legacy) return { view };
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
  if (view === 'papers') {
    const area = arxivAreaSchema.safeParse(query.get('area'));
    return { view, key: value, area: area.success ? area.data : null };
  }
  if (view === 'benchmark' && value) return { view, id: value };
  if (view === 'apps') return { view };
  if (view === 'expert-articles') return { view };
  if (view === 'data') return { view };
  if (view === 'account') return { view, error: query.get('error') };
  return { view: 'brief', job: null };
}

export function routeHref(route: Route) {
  if (route.view === 'brief')
    return route.job ? `#/brief/${encodeURIComponent(route.job)}` : '#/';
  if (route.view === 'board') return '#/board';
  if (route.view === 'benchmark')
    return `#/benchmark/${encodeURIComponent(route.id)}`;
  if (
    route.view === 'apps' ||
    route.view === 'data' ||
    route.view === 'expert-articles'
  )
    return `#/${route.view}`;
  if (route.view === 'account')
    return `#/account${route.error ? `?${new URLSearchParams({ error: route.error })}` : ''}`;
  if (route.view === 'papers')
    return `#/papers${route.key ? `/${encodeURIComponent(route.key)}` : ''}${route.area ? `?area=${route.area}` : ''}`;
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

// A link from an older comment-index key (`model:<id>`, `family:<name>`).
export function keyHref(key: string, comments = false) {
  return routeHref({
    view: 'model',
    target: modelTarget(encodeURIComponent(key)),
    job: null,
    comments,
  });
}

export function useHash() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return hash;
}
