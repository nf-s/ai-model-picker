import { ArrowUpRight } from 'lucide-react';
import type { PractitionerFinding } from '../lib/practitioner';
import { modelById } from '../lib/site-data';
import './reports.css';

const attributionLabel: Record<PractitionerFinding['attribution'], string> = {
  'author observation': 'Firsthand observation',
  'author advice': 'Author advice',
  'reported by source': 'Secondhand report',
  'project documentation': 'Project documentation',
  'attributed speaker': 'Attributed speaker',
};
const targetLabel = {
  model: 'Exact model',
  family: 'Model family',
  tool: 'Tool',
};

export default function PractitionerFindings({
  findings,
  heading: Heading = 'h3',
}: {
  findings: readonly PractitionerFinding[];
  heading?: 'h3' | 'h5';
}) {
  return (
    <ul className="rd-reports rd-practitioner-findings">
      {findings.map((finding) => (
        <li key={finding.sourceUrl} className="rd-panel">
          <p className="rd-report-meta">
            <span className="rd-practitioner-kind">{finding.kind}</span>
            {' · '}
            {attributionLabel[finding.attribution]}
            {' · '}
            <time dateTime={finding.date}>{finding.date}</time>
          </p>
          <Heading className="rd-practitioner-title">{finding.title}</Heading>
          <p>{finding.summary}</p>
          <p className="rd-note">{finding.conditions}</p>
          {finding.targets.length > 0 && (
            <p className="rd-report-meta rd-report-models">
              {finding.targets.map((item) => (
                <span key={`${item.kind}:${item.id}`}>
                  {targetLabel[item.kind]} ·{' '}
                  {item.kind === 'model'
                    ? (modelById.get(item.id)?.name ?? item.id)
                    : item.id}
                </span>
              ))}
            </p>
          )}
          <p className="rd-report-models">
            <a
              href={finding.sourceUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`Original HN comment for ${finding.title}`}
            >
              Original HN comment
              <ArrowUpRight size={12} aria-hidden="true" />
            </a>
            <a
              href={finding.contextUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`Thread context for ${finding.title}`}
            >
              Thread context
              <ArrowUpRight size={12} aria-hidden="true" />
            </a>
          </p>
        </li>
      ))}
    </ul>
  );
}
