import { ArrowUpRight } from 'lucide-react';
import type { Report } from '../lib/data';
import { dollars, formatNumber } from '../lib/metrics';
import { modelHref } from '../lib/route';
import { modelById } from '../lib/site-data';
import './reports.css';

function plain(label: string) {
  return label.replace(/-/g, ' ');
}

// Published reports and experiments from the snapshot. `omitModelId` leaves
// the page's own model out of each report's model links.
export default function Reports({
  reports,
  omitModelId,
}: {
  reports: readonly Report[];
  omitModelId?: string;
}) {
  return (
    <ul className="rd-reports">
      {reports.map((report) => {
        const others = report.modelIds.flatMap((id) => {
          const model = id === omitModelId ? undefined : modelById.get(id);
          return model ? [model] : [];
        });
        const metrics = report.metrics ?? [];
        return (
          <li key={report.id} className="rd-panel">
            <p className="rd-report-meta">
              {report.sourceName} · {plain(report.evidenceType)}
              {report.publishedAt && ` · ${report.publishedAt}`}
            </p>
            <h3>
              <a href={report.url} target="_blank" rel="noreferrer">
                {report.title}
                <ArrowUpRight size={12} aria-hidden="true" />
              </a>
            </h3>
            <p>{report.summary}</p>
            {(metrics.length > 0 || report.costUsd !== undefined) && (
              <dl>
                {metrics.map((metric, position) => (
                  <div key={`${metric.label}-${position}`}>
                    <dt>{metric.label}</dt>
                    <dd>
                      {typeof metric.value === 'number'
                        ? formatNumber(metric.value)
                        : metric.value}
                      {metric.unit && ` ${metric.unit}`}
                    </dd>
                  </div>
                ))}
                {report.costUsd !== undefined && (
                  <div>
                    <dt>{plain(report.costType ?? 'Reported spend')}</dt>
                    <dd>{dollars(report.costUsd)}</dd>
                  </div>
                )}
              </dl>
            )}
            {report.configuration && (
              <p className="rd-note">Configuration: {report.configuration}</p>
            )}
            {report.costContext && (
              <p className="rd-note">Cost: {report.costContext}</p>
            )}
            <p className="rd-note">Limitations: {report.limitation}</p>
            {others.length > 0 && (
              <p className="rd-report-models">
                <span className="rd-muted">
                  {omitModelId ? 'Also covers' : 'Covers'}
                </span>
                {others.map((model) => (
                  <a key={model.id} href={modelHref(model.id)}>
                    {model.name}
                  </a>
                ))}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
