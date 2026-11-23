import type { Attribution } from './attribution.ts';
import type { Core } from './core-schema.ts';
import type { Snapshot } from './schema.ts';

// The Data page's JSON download: public records and their attribution only.
// It holds no practitioner record or quote (those stay behind sign-in), no
// restricted result (the snapshot is copied before they are added), and no
// OpenRouter usage, whose terms do not allow re-serving it as a data API.
export function publicDownload(
  snapshot: Snapshot,
  core: Core,
  attributions: readonly Attribution[],
) {
  return {
    snapshot,
    records: {
      jobs: {
        version: core.jobs.version,
        status: core.jobs.status,
        list: core.jobs.list,
      },
      benchmarks: core.benchmarks,
      measured: core.measured,
      imported: { lmarena: core.sources.lmarena, epoch: core.sources.epoch },
    },
    attribution: attributions,
  };
}
