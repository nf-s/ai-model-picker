import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { signInHref } from '../lib/access';
import type { Access } from '../lib/access';
import { loadExpertArticles } from '../lib/expert-articles';
import type {
  ExpertArticle,
  ExpertArticlesResult,
} from '../lib/expert-articles';
import { routeHref } from '../lib/route';
import './expert-articles.css';

const pageSize = 25;
const dateFormat = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

function Catalog({ articles }: { articles: ExpertArticle[] }) {
  const [filters, setFilters] = useState({ title: '', source: '', year: '' });
  const [page, setPage] = useState(0);
  const results = useRef<HTMLParagraphElement>(null);
  const sources = [
    ...new Set(articles.map((article) => article.source)),
  ].sort();
  const years = [
    ...new Set(articles.map((article) => article.date.slice(0, 4))),
  ];
  const query = filters.title.trim().toLocaleLowerCase();
  const matches = articles.filter(
    (article) =>
      (!filters.source || article.source === filters.source) &&
      (!filters.year || article.date.startsWith(filters.year)) &&
      article.title.toLocaleLowerCase().includes(query),
  );
  const start = page * pageSize;
  const visible = matches.slice(start, start + pageSize);

  function changeFilter(field: keyof typeof filters, value: string) {
    setFilters((previous) => ({ ...previous, [field]: value }));
    setPage(0);
  }

  function goToPage(next: number) {
    setPage(next);
    results.current?.focus();
  }

  return (
    <section className="rd-section" aria-label="Article catalog">
      <div className="rd-ea-filters">
        <label>
          Title
          <input
            className="rd-input"
            type="search"
            value={filters.title}
            onChange={(event) => changeFilter('title', event.target.value)}
          />
        </label>
        <label>
          Source
          <select
            className="rd-select"
            value={filters.source}
            onChange={(event) => changeFilter('source', event.target.value)}
          >
            <option value="">All sources</option>
            {sources.map((source) => (
              <option key={source}>{source}</option>
            ))}
          </select>
        </label>
        <label>
          Year
          <select
            className="rd-select"
            value={filters.year}
            onChange={(event) => changeFilter('year', event.target.value)}
          >
            <option value="">All years</option>
            {years.map((year) => (
              <option key={year}>{year}</option>
            ))}
          </select>
        </label>
      </div>
      <p
        className="rd-note rd-ea-count"
        ref={results}
        tabIndex={-1}
        role="status"
      >
        {visible.length
          ? `${(start + 1).toLocaleString()}–${(start + visible.length).toLocaleString()} of ${matches.length.toLocaleString()} articles`
          : 'No articles match these filters.'}
      </p>
      {visible.length > 0 && (
        <ul className="rd-ea-list">
          {visible.map((article) => (
            <li className="rd-panel rd-ea-article" key={article.url}>
              <a href={article.url} target="_blank" rel="noreferrer">
                {article.title}
                <ArrowUpRight size={12} aria-hidden="true" />
              </a>
              <p>
                <span>{article.source}</span>
                <time dateTime={article.date}>
                  {dateFormat.format(new Date(article.date))}
                </time>
              </p>
            </li>
          ))}
        </ul>
      )}
      {matches.length > pageSize && (
        <nav className="rd-ea-pager" aria-label="Article pages">
          <button
            type="button"
            className="rd-button"
            disabled={page === 0}
            onClick={() => goToPage(page - 1)}
          >
            Previous
          </button>
          <button
            type="button"
            className="rd-button"
            disabled={start + pageSize >= matches.length}
            onClick={() => goToPage(page + 1)}
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}

type CatalogState =
  ExpertArticlesResult | { kind: 'loading' } | { kind: 'failed' };

export default function ExpertArticles({ access }: { access: Access }) {
  const canLoad = access.kind === 'signed-in' || access.kind === 'local';
  const [state, setState] = useState<CatalogState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!canLoad) return;
    const controller = new AbortController();
    loadExpertArticles(controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setState(result);
      },
      () => {
        if (!controller.signal.aborted) setState({ kind: 'failed' });
      },
    );
    return () => controller.abort();
  }, [canLoad, attempt]);

  const signIn = signInHref(`/${routeHref({ view: 'expert-articles' })}`);
  return (
    <div className="rd-page">
      <header className="rd-page-head">
        <h1>Expert articles</h1>
      </header>
      {!canLoad || state.kind === 'sign-in' ? (
        <div className="rd-section">
          <p className="rd-note">
            {access.kind === 'unavailable'
              ? 'The account service could not be reached.'
              : 'An approved Google account is required.'}
          </p>
          <div>
            <a className="rd-button rd-button-primary" href={signIn}>
              Sign in with Google
            </a>
          </div>
        </div>
      ) : state.kind === 'ready' ? (
        <Catalog articles={state.articles} />
      ) : state.kind === 'failed' ? (
        <div className="rd-section">
          <p className="rd-note" role="alert">
            The article catalog could not be loaded.
          </p>
          <div>
            <button
              type="button"
              className="rd-button"
              onClick={() => {
                setState({ kind: 'loading' });
                setAttempt((value) => value + 1);
              }}
            >
              Try again
            </button>
          </div>
        </div>
      ) : (
        <p className="rd-note" role="status">
          Loading articles…
        </p>
      )}
    </div>
  );
}
