import { useEffect, useState } from 'react';
import { arxivAreaSchema } from './arxiv-schema.ts';
import type { ArxivArea } from './arxiv-schema.ts';

export type Route =
  | { view: 'board' }
  | { view: 'model'; key: string | null }
  | { view: 'discussion'; key: string | null }
  | { view: 'papers'; key: string | null; area: ArxivArea | null }
  | { view: 'expert-articles' }
  | { view: 'benchmark'; id: string }
  | { view: 'apps' }
  | { view: 'data' }
  | { view: 'account'; error: string | null };

// Hashes from the prototype period (`#/redesign/board`) keep working.
const legacyPrefix = 'redesign/';

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
  const { path, query } = splitQuery(
    trimmed.startsWith(legacyPrefix)
      ? trimmed.slice(legacyPrefix.length)
      : trimmed,
  );
  const [view, ...rest] = path.split('/');
  const detail = rest.join('/');
  const value = detail ? decode(detail) : null;
  if (view === 'model') return { view, key: value };
  if (view === 'discussion') return { view, key: value };
  if (view === 'papers') {
    const area = arxivAreaSchema.safeParse(query.get('area'));
    return { view, key: value, area: area.success ? area.data : null };
  }
  if (view === 'benchmark' && value) return { view, id: value };
  if (view === 'apps') return { view };
  if (view === 'expert-articles') return { view };
  if (view === 'data') return { view };
  if (view === 'account') return { view, error: query.get('error') };
  return { view: 'board' };
}

export function routeHref(route: Route) {
  if (route.view === 'board') return '#/';
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
  return `#/${route.view}${route.key ? `/${encodeURIComponent(route.key)}` : ''}`;
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
