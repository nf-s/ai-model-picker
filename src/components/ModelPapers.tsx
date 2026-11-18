import { useMemo, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useArxivData } from '../lib/arxiv-client';
import {
  areaLabels,
  paperDayFormat,
  standingLabels,
  targetResults,
} from '../lib/arxiv-papers';
import type { Standing } from '../lib/arxiv-papers';
import { routeHref } from '../lib/route';
import './papers.css';

const firstRows = 6;

// Evaluation papers whose result names `target`, a model or family key.
export default function ModelPapers({ target }: { target: string }) {
  const arxiv = useArxivData();
  const [all, setAll] = useState(false);
  const rows = useMemo(
    () =>
      arxiv.status === 'ready'
        ? targetResults(arxiv.snapshot.papers, target)
        : [],
    [arxiv, target],
  );
  if (rows.length === 0) return null;
  const count = (standing: Standing) =>
    rows.filter((row) => row.standing === standing).length;
  const shown = all ? rows : rows.slice(0, firstRows);
  return (
    <section aria-labelledby="rd-mf-papers">
      <h2 className="rd-h" id="rd-mf-papers">
        Paper evaluations · {rows.length.toLocaleString()}
      </h2>
      <p className="rd-mf-papers-tally">
        Best in <strong>{count('best').toLocaleString()}</strong> · behind in{' '}
        <strong>{count('weak').toLocaleString()}</strong> ·{' '}
        <strong>{rows.length.toLocaleString()}</strong> evaluation{' '}
        {rows.length === 1 ? 'paper' : 'papers'} ·{' '}
        <a href={routeHref({ view: 'papers', key: target, area: null })}>
          Open in Papers
        </a>
      </p>
      <ol className="rd-panel rd-mf-papers">
        {shown.map(({ paper, result, standing }) => (
          <li key={paper.id}>
            <p className="rd-mf-papers-what">
              {standing !== 'unranked' && (
                <span className={`rd-pp-standing rd-pp-${standing}`}>
                  {standingLabels[standing]}
                </span>
              )}
              <span className="rd-pp-area">{areaLabels[result.area]}</span>
              {result.task}
            </p>
            {result.finding && (
              <p className="rd-mf-papers-finding">{result.finding}</p>
            )}
            <p className="rd-mf-papers-source">
              <a
                href={`https://arxiv.org/abs/${paper.id}`}
                target="_blank"
                rel="noreferrer"
              >
                {paper.title}
                <ArrowUpRight size={12} aria-hidden="true" />
              </a>
              <time dateTime={paper.submittedAt}>
                {paperDayFormat.format(new Date(paper.submittedAt))}
              </time>
            </p>
          </li>
        ))}
      </ol>
      {rows.length > firstRows && (
        <button type="button" className="rd-more" onClick={() => setAll(!all)}>
          {all
            ? `Show first ${firstRows}`
            : `Show all ${rows.length.toLocaleString()}`}
        </button>
      )}
      <p className="rd-note">
        Results are extracted automatically from abstracts only, by a local
        model, and can be wrong. Behind means the abstract ranks another tracked
        model best and this one below it, which includes close seconds. A row
        without a tag names the model without ranking it.
      </p>
    </section>
  );
}
