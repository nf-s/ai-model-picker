import { useEffect, useMemo, useState } from 'react';
import { prepareBrief } from './brief';
import { coreSchema } from './core-schema';
import type { Core } from './core-schema';
import { restrictedData } from './data';

export type CoreData =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; core: Core };

let shared: Promise<Core> | null = null;

// The development server serves build/records/core.json at this path; the
// published build has a copy in dist/.
async function readCore() {
  const response = await fetch('/core.json', {
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('Could not read the records.');
  const raw: unknown = await response.json();
  return coreSchema.parse(raw);
}

// Loaded once per session, on the first view that needs it.
function loadCore() {
  shared ??= readCore().catch((error: unknown) => {
    shared = null;
    throw error;
  });
  return shared;
}

export function useCoreData(): CoreData {
  const [data, setData] = useState<CoreData>({ status: 'loading' });
  useEffect(() => {
    let current = true;
    loadCore().then(
      (core) => {
        if (current) setData({ status: 'ready', core });
      },
      () => {
        if (current) setData({ status: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, []);
  return data;
}

// The records the views show, with the restricted payload's results added
// for a signed-in, granted account and on the local dev server.
export function useBriefData(coreData: CoreData) {
  const core = coreData.status === 'ready' ? coreData.core : null;
  return useMemo(
    () =>
      core
        ? prepareBrief(
            core,
            restrictedData.benchmarks.length > 0 ? restrictedData : null,
          )
        : null,
    [core],
  );
}
